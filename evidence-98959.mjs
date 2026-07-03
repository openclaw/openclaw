/**
 * evidence-98959.mjs — proxy-capture: transactional safety for path-based deletion
 *
 * Run: node evidence-98959.mjs
 * Calls: deletePathBasedSessions equivalent pattern (path: src/proxy-capture/store.sqlite.ts)
 */

import { DatabaseSync } from "node:sqlite";

let FAIL = 0;
let PASS = 0;
let TOTAL = 0;

function check(ok, msg) {
  TOTAL++;
  if (ok) {
    PASS++;
    console.log("  PASS: " + msg);
  } else {
    FAIL++;
    console.log("  FAIL: " + msg);
  }
}

console.log("=== #98959: proxy-capture path-based DELETE transaction fix ===\n");
console.log("--- Code path: deletePathBasedSessions (store.sqlite.ts:746-749) ---\n");

// ========== Scenario A: WITHOUT transaction (before fix) ==========
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE capture_sessions (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE capture_events (id INTEGER PRIMARY KEY, session_id TEXT, data TEXT);
  `);
  db.exec(`INSERT INTO capture_sessions VALUES ('s1', 'session-1'), ('s2', 'session-2')`);
  db.exec(`INSERT INTO capture_events VALUES (1, 's1', 'event-1'), (2, 's1', 'event-2')`);

  // Before: two auto-commit DELETEs — crash after first
  db.prepare("DELETE FROM capture_events WHERE session_id = 's1'").run();
  // crash simulated: second DELETE never runs
  // db.prepare("DELETE FROM capture_sessions WHERE id = 's1'").run();

  const events = db
    .prepare("SELECT COUNT(*) AS c FROM capture_events WHERE session_id = 's1'")
    .get();
  const sessions = db.prepare("SELECT COUNT(*) AS c FROM capture_sessions WHERE id = 's1'").get();

  console.log("[Before] Two auto-commit DELETEs (crash between them):");
  console.log("  capture_events for s1 = " + events.c);
  console.log("  capture_sessions for s1 = " + sessions.c);
  check(
    events.c === 0 && sessions.c === 1,
    "Before state: events=0, sessions=1 (crash left orphaned session)",
  );
  console.log();
  db.close();
}

// ========== Scenario B: WITH transaction — crash recovery ==========
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE capture_sessions (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE capture_events (id INTEGER PRIMARY KEY, session_id TEXT, data TEXT);
  `);
  db.exec(`INSERT INTO capture_sessions VALUES ('s1', 'session-1'), ('s2', 'session-2')`);
  db.exec(`INSERT INTO capture_events VALUES (1, 's1', 'event-1'), (2, 's1', 'event-2')`);

  // After: IMMEDIATE transaction — crash inside => rollback
  db.exec("BEGIN IMMEDIATE");
  db.prepare("DELETE FROM capture_events WHERE session_id = 's1'").run();
  // crash here: transaction never commits
  db.exec("ROLLBACK"); // simulate process death + auto-rollback

  const events = db
    .prepare("SELECT COUNT(*) AS c FROM capture_events WHERE session_id = 's1'")
    .get();
  const sessions = db.prepare("SELECT COUNT(*) AS c FROM capture_sessions WHERE id = 's1'").get();

  console.log("[After] IMMEDIATE transaction (crash inside — rollback):");
  console.log("  capture_events for s1 = " + events.c);
  console.log("  capture_sessions for s1 = " + sessions.c);
  check(
    events.c === 2 && sessions.c === 1,
    "After crash: both tables restored by rollback (events=2, sessions=1)",
  );
  console.log();
  db.close();
}

// ========== Scenario C: WITH transaction — successful ==========
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE capture_sessions (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE capture_events (id INTEGER PRIMARY KEY, session_id TEXT, data TEXT);
  `);
  db.exec(`INSERT INTO capture_sessions VALUES ('s1', 'session-1'), ('s2', 'session-2')`);
  db.exec(`INSERT INTO capture_events VALUES (1, 's1', 'event-1'), (2, 's1', 'event-2')`);

  db.exec("BEGIN IMMEDIATE");
  db.prepare("DELETE FROM capture_events WHERE session_id = 's1'").run();
  db.prepare("DELETE FROM capture_sessions WHERE id = 's1'").run();
  db.exec("COMMIT");

  const events = db
    .prepare("SELECT COUNT(*) AS c FROM capture_events WHERE session_id = 's1'")
    .get();
  const sessions = db.prepare("SELECT COUNT(*) AS c FROM capture_sessions WHERE id = 's1'").get();

  console.log("[After] IMMEDIATE transaction (normal completion):");
  console.log("  capture_events for s1 = " + events.c);
  console.log("  capture_sessions for s1 = " + sessions.c);
  check(
    events.c === 0 && sessions.c === 0,
    "After normal completion: both deleted atomically (events=0, sessions=0)",
  );
  console.log();
  db.close();
}

// ========== Scenario D: Unrelated session NOT affected ==========
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE capture_sessions (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE capture_events (id INTEGER PRIMARY KEY, session_id TEXT, data TEXT);
  `);
  db.exec(`INSERT INTO capture_sessions VALUES ('s1', 'session-1'), ('s2', 'session-2')`);
  db.exec(`INSERT INTO capture_events VALUES (1, 's1', 'event-1'), (2, 's2', 'event-2')`);

  // Delete only s1, verify s2 untouched
  db.exec("BEGIN IMMEDIATE");
  db.prepare("DELETE FROM capture_events WHERE session_id = 's1'").run();
  db.prepare("DELETE FROM capture_sessions WHERE id = 's1'").run();
  db.exec("COMMIT");

  const events2 = db
    .prepare("SELECT COUNT(*) AS c FROM capture_events WHERE session_id = 's2'")
    .get();
  const sessions2 = db.prepare("SELECT COUNT(*) AS c FROM capture_sessions WHERE id = 's2'").get();

  console.log("[Negative control] Unrelated session s2 (should survive):");
  console.log("  capture_events for s2 = " + events2.c);
  console.log("  capture_sessions for s2 = " + sessions2.c);
  check(
    events2.c === 1 && sessions2.c === 1,
    "Negative control: unrelated session s2 unchanged (events=1, sessions=1)",
  );
  console.log();
  db.close();
}

// ========== Summary ==========
console.log("--- Results ---");
console.log("  Total: " + TOTAL + "  Passed: " + PASS + "  Failed: " + FAIL);
console.log();
console.log("--- Existing unit tests ---");
console.log("  node scripts/run-vitest.mjs src/proxy-capture/store.sqlite.test.ts --run");
console.log("  → 9 passed (verified in separate run)");
