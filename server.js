const express = require("express");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@libsql/client");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ══════════ DATABASE ══════════
const dbUrl = process.env.TURSO_URL || "file:academy.db";
const dbToken = process.env.TURSO_TOKEN || undefined;

console.log("Connecting to DB:", dbUrl.startsWith("libsql") ? "Turso Cloud" : "Local file");

let db;
try {
  db = createClient({ url: dbUrl, authToken: dbToken });
} catch (e) {
  console.error("Failed to create DB client:", e.message);
  process.exit(1);
}

async function initDB() {
  try {
    // Use individual execute calls instead of batch for better Turso compatibility
    await db.execute(`CREATE TABLE IF NOT EXISTS accounts (uid TEXT PRIMARY KEY, password TEXT NOT NULL, displayName TEXT NOT NULL, created TEXT)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS user_data (uid TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}')`);
    await db.execute(`CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, qid TEXT NOT NULL, qname TEXT, score INTEGER, total INTEGER, pct INTEGER, time INTEGER, passed INTEGER, date TEXT, num INTEGER)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS strikes (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, reason TEXT, date TEXT, removedAt TEXT, removedReason TEXT)`);
    console.log("Database tables ready.");
  } catch (e) {
    console.error("Table creation error:", e.message);
    throw e;
  }
}

// ══════════ HEALTH CHECK ══════════
app.get("/api/health", (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

// ══════════ AUTH ══════════
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.json({ ok: false, error: "Please enter username and password." });
    }
    const uid = (username || "").toLowerCase().trim();
    const row = await db.execute({ sql: "SELECT * FROM accounts WHERE uid = ? AND password = ?", args: [uid, password] });
    if (!row.rows.length) return res.json({ ok: false, error: "Invalid username or password. Check your credentials." });
    const account = row.rows[0];
    let ud;
    try {
      ud = await db.execute({ sql: "SELECT data FROM user_data WHERE uid = ?", args: [uid] });
    } catch (e) { ud = { rows: [] }; }
    if (!ud.rows.length) {
      try { await db.execute({ sql: "INSERT INTO user_data (uid, data) VALUES (?, ?)", args: [uid, "{}"] }); } catch(e) {}
      ud = { rows: [{ data: "{}" }] };
    }
    let userData = {};
    try { userData = JSON.parse(ud.rows[0].data || "{}"); } catch(e) {}
    res.json({ ok: true, uid: account.uid, displayName: account.displayName, userData });
  } catch (e) { 
    console.error("Login error:", e.message); 
    res.json({ ok: false, error: "Server error. Please try again later." }); 
  }
});

// ══════════ ADMIN AUTH ══════════
const ADMIN_PW = process.env.ADMIN_PW || "admin123";
app.post("/api/admin/login", (req, res) => {
  if (!req.body.password) {
    return res.json({ ok: false, error: "Please enter the manager password." });
  }
  if (req.body.password === ADMIN_PW) return res.json({ ok: true });
  res.json({ ok: false, error: "Incorrect manager password." });
});

// ══════════ USER DATA ══════════
app.get("/api/user/:uid", async (req, res) => {
  try {
    const row = await db.execute({ sql: "SELECT data FROM user_data WHERE uid = ?", args: [req.params.uid] });
    let data = {};
    if (row.rows.length) try { data = JSON.parse(row.rows[0].data || "{}"); } catch(e) {}
    res.json({ data });
  } catch (e) { console.error("Get user error:", e.message); res.json({ data: {} }); }
});

app.post("/api/user/:uid", async (req, res) => {
  try {
    const uid = req.params.uid;
    const data = JSON.stringify(req.body.data || {});
    await db.execute({ sql: "INSERT INTO user_data (uid, data) VALUES (?, ?) ON CONFLICT(uid) DO UPDATE SET data = ?", args: [uid, data, data] });
    res.json({ ok: true });
  } catch (e) { console.error("Save user error:", e.message); res.json({ ok: false, error: "Failed to save progress." }); }
});

// ══════════ RESULTS ══════════
app.post("/api/results", async (req, res) => {
  try {
    const r = req.body;
    await db.execute({
      sql: "INSERT INTO results (uid, qid, qname, score, total, pct, time, passed, date, num) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [r.uid, r.qid, r.qname, r.score, r.total, r.pct, r.time, r.passed ? 1 : 0, r.date || new Date().toISOString(), r.num]
    });
    res.json({ ok: true });
  } catch (e) { console.error("Save result error:", e.message); res.json({ ok: false, error: "Failed to save result." }); }
});

app.get("/api/results", async (req, res) => {
  try {
    const rows = await db.execute(`
      SELECT r.*, a.displayName as name
      FROM results r
      JOIN accounts a ON r.uid = a.uid
      ORDER BY r.date DESC LIMIT 500
    `);
    res.json(rows.rows);
  } catch (e) { console.error("Get results error:", e.message); res.json([]); }
});

app.get("/api/results/:uid", async (req, res) => {
  try {
    const rows = await db.execute({ sql: "SELECT * FROM results WHERE uid = ? ORDER BY date DESC", args: [req.params.uid] });
    res.json(rows.rows);
  } catch (e) { res.json([]); }
});

// ══════════ STRIKES ══════════
// Get all strikes (active only by default)
app.get("/api/strikes", async (req, res) => {
  try {
    const includeRemoved = req.query.all === "true";
    const sql = includeRemoved 
      ? "SELECT s.*, a.displayName as name FROM strikes s JOIN accounts a ON s.uid = a.uid ORDER BY s.date DESC"
      : "SELECT s.*, a.displayName as name FROM strikes s JOIN accounts a ON s.uid = a.uid WHERE s.removedAt IS NULL ORDER BY s.date DESC";
    const rows = await db.execute(sql);
    res.json(rows.rows);
  } catch (e) { console.error("Get strikes error:", e.message); res.json([]); }
});

// Get strikes for specific user
app.get("/api/strikes/:uid", async (req, res) => {
  try {
    const rows = await db.execute({ 
      sql: "SELECT * FROM strikes WHERE uid = ? AND removedAt IS NULL ORDER BY date DESC", 
      args: [req.params.uid] 
    });
    res.json(rows.rows);
  } catch (e) { res.json([]); }
});

// Add strike
app.post("/api/strikes", async (req, res) => {
  try {
    const { uid, reason } = req.body;
    if (!uid) return res.json({ ok: false, error: "User ID required." });
    await db.execute({
      sql: "INSERT INTO strikes (uid, reason, date) VALUES (?, ?, ?)",
      args: [uid, reason || "Missed daily tasks", new Date().toISOString()]
    });
    res.json({ ok: true });
  } catch (e) { console.error("Add strike error:", e.message); res.json({ ok: false, error: "Failed to add strike." }); }
});

// Remove strike (soft delete)
app.delete("/api/strikes/:id", async (req, res) => {
  try {
    const { reason } = req.body || {};
    await db.execute({
      sql: "UPDATE strikes SET removedAt = ?, removedReason = ? WHERE id = ?",
      args: [new Date().toISOString(), reason || "Removed by manager", req.params.id]
    });
    res.json({ ok: true });
  } catch (e) { console.error("Remove strike error:", e.message); res.json({ ok: false, error: "Failed to remove strike." }); }
});

// Get strike summary (count per user)
app.get("/api/strikes/summary/all", async (req, res) => {
  try {
    const rows = await db.execute(`
      SELECT s.uid, a.displayName as name, COUNT(*) as strikeCount,
             MAX(s.date) as lastStrike
      FROM strikes s 
      JOIN accounts a ON s.uid = a.uid 
      WHERE s.removedAt IS NULL 
      GROUP BY s.uid 
      ORDER BY strikeCount DESC, lastStrike DESC
    `);
    res.json(rows.rows);
  } catch (e) { console.error("Strike summary error:", e.message); res.json([]); }
});

// Bulk add strikes (for daily check)
app.post("/api/strikes/bulk", async (req, res) => {
  try {
    const { users, reason } = req.body; // users = [{ uid, reason? }]
    if (!Array.isArray(users) || !users.length) return res.json({ ok: false, error: "No users provided." });
    const date = new Date().toISOString();
    for (const u of users) {
      await db.execute({
        sql: "INSERT INTO strikes (uid, reason, date) VALUES (?, ?, ?)",
        args: [u.uid, u.reason || reason || "Missed daily tasks", date]
      });
    }
    res.json({ ok: true, count: users.length });
  } catch (e) { console.error("Bulk strike error:", e.message); res.json({ ok: false, error: "Failed to add strikes." }); }
});

// ══════════ ACCOUNTS (Admin) ══════════
app.get("/api/accounts", async (req, res) => {
  try {
    const rows = await db.execute("SELECT uid, displayName, created FROM accounts");
    const result = [];
    for (const r of rows.rows) {
      let userData = {};
      try {
        const ud = await db.execute({ sql: "SELECT data FROM user_data WHERE uid = ?", args: [r.uid] });
        if (ud.rows.length) userData = JSON.parse(ud.rows[0].data || "{}");
      } catch(e) {}
      // Get strike count
      let strikeCount = 0;
      try {
        const sc = await db.execute({ sql: "SELECT COUNT(*) as cnt FROM strikes WHERE uid = ? AND removedAt IS NULL", args: [r.uid] });
        strikeCount = sc.rows[0]?.cnt || 0;
      } catch(e) {}
      result.push({ ...r, userData, strikeCount });
    }
    res.json(result);
  } catch (e) { console.error("Get accounts error:", e.message); res.json([]); }
});

app.post("/api/accounts", async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    const uid = (username || "").toLowerCase().trim();
    if (!uid || uid.length < 2) return res.json({ ok: false, error: "Username must be at least 2 characters." });
    if (!password || password.length < 4) return res.json({ ok: false, error: "Password must be at least 4 characters." });
    const exists = await db.execute({ sql: "SELECT uid FROM accounts WHERE uid = ?", args: [uid] });
    if (exists.rows.length) return res.json({ ok: false, error: "Username already exists. Choose a different one." });
    await db.execute({ sql: "INSERT INTO accounts (uid, password, displayName) VALUES (?, ?, ?)", args: [uid, password, displayName || username] });
    await db.execute({ sql: "INSERT INTO user_data (uid, data) VALUES (?, ?)", args: [uid, "{}"] });
    res.json({ ok: true, uid, password });
  } catch (e) { console.error("Create account error:", e.message); res.json({ ok: false, error: "Server error creating account." }); }
});

app.delete("/api/accounts/:uid", async (req, res) => {
  try {
    await db.execute({ sql: "DELETE FROM strikes WHERE uid = ?", args: [req.params.uid] });
    await db.execute({ sql: "DELETE FROM results WHERE uid = ?", args: [req.params.uid] });
    await db.execute({ sql: "DELETE FROM user_data WHERE uid = ?", args: [req.params.uid] });
    await db.execute({ sql: "DELETE FROM accounts WHERE uid = ?", args: [req.params.uid] });
    res.json({ ok: true });
  } catch (e) { console.error("Delete account error:", e.message); res.json({ ok: false, error: "Failed to delete account." }); }
});

app.post("/api/accounts/:uid/reset", async (req, res) => {
  try {
    await db.execute({ sql: "DELETE FROM results WHERE uid = ?", args: [req.params.uid] });
    await db.execute({ sql: "DELETE FROM strikes WHERE uid = ?", args: [req.params.uid] });
    await db.execute({ sql: "UPDATE user_data SET data = '{}' WHERE uid = ?", args: [req.params.uid] });
    res.json({ ok: true });
  } catch (e) { console.error("Reset error:", e.message); res.json({ ok: false, error: "Failed to reset progress." }); }
});

// ══════════ SERVE HTML ══════════
app.use(express.static(__dirname));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ══════════ START ══════════
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Sales Funnel Academy running on port ${PORT}`);
    console.log(`Admin password: ${ADMIN_PW === "admin123" ? "⚠️  DEFAULT (change ADMIN_PW!)" : "✓ Custom"}`);
  });
}).catch(e => {
  console.error("FATAL: Could not initialize database:", e.message);
  console.error("Check your TURSO_URL and TURSO_TOKEN environment variables.");
  process.exit(1);
});
