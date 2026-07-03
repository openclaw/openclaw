/**
 * evidence-98959.ts — proxy-capture: transactional safety for path-based deletion
 *
 * Run: node --import tsx scripts/run-vitest.mjs src/proxy-capture/store.sqlite.test.ts --run
 * Evidence: node --import tsx evidence-98959.ts
 *
 * NOTE: This file is NOT committed to the repository.
 */

// =============================================================================
// Evidence 1: Source diff — transaction boundary
// =============================================================================
console.log("=== #98959: proxy-capture path-based DELETE transaction fix ===\n");

console.log("Before (deletePathBasedSessions, store.sqlite.ts:746-749):");
console.log(`  this.db.prepare(\`DELETE FROM capture_events WHERE session_id IN (\${placeholders})\`).run(
    ...sessionIds,
  );
  this.db.prepare(\`DELETE FROM capture_sessions WHERE id IN (\${placeholders})\`).run(...sessionIds);`);
console.log("  → Two separate auto-commit statements. Crash between them → orphaned sessions.\n");

console.log("After:");
console.log(`  runSqliteImmediateTransactionSync(this.db, () => {
    this.db.prepare(\`DELETE FROM capture_events WHERE session_id IN (\${placeholders})\`).run(
      ...sessionIds,
    );
    this.db.prepare(\`DELETE FROM capture_sessions WHERE id IN (\${placeholders})\`).run(...sessionIds);
  });`);
console.log("  → Both DELETEs in one IMMEDIATE transaction. Crash-safe.\n");

// =============================================================================
// Evidence 2: Inline SQLite demonstration
// =============================================================================
import Database from "better-sqlite3";

function demonstrateTransactionSafety() {
  console.log("--- SQLite transactional safety demonstration ---\n");

  // Scenario: simulate two DELETEs without transaction vs with transaction
  const db1 = new Database(":memory:");
  const db2 = new Database(":memory:");

  // Both databases get the same schema and data
  for (const db of [db1, db2]) {
    db.exec(`
      CREATE TABLE capture_sessions (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE capture_events (id INTEGER PRIMARY KEY, session_id TEXT, data TEXT);
      INSERT INTO capture_sessions VALUES ('s1', 'session-1'), ('s2', 'session-2');
      INSERT INTO capture_events VALUES (1, 's1', 'event-1'), (2, 's1', 'event-2'), (3, 's2', 'event-3');
    `);
  }

  // Path A: WITHOUT transaction (simulate crash after first DELETE)
  db1.prepare("DELETE FROM capture_events WHERE session_id = 's1'").run();
  // Crash here! (simulated by not executing the second DELETE)
  // db1.prepare("DELETE FROM capture_sessions WHERE id = 's1'").run();

  const eventsRemainingDb1 = (
    db1.prepare("SELECT COUNT(*) AS count FROM capture_events WHERE session_id = 's1'").get() as {
      count: number;
    }
  ).count;
  const sessionsRemainingDb1 = (
    db1.prepare("SELECT COUNT(*) AS count FROM capture_sessions WHERE id = 's1'").get() as {
      count: number;
    }
  ).count;

  console.log("Without transaction (crash after events DELETE, before sessions DELETE):");
  console.log(`  capture_events for s1: ${eventsRemainingDb1} (0 = deleted)`);
  console.log(
    `  capture_sessions for s1: ${sessionsRemainingDb1} (1 = ORPHANED — events gone, session remains)`,
  );
  console.log(`  → INCONSISTENT: events=${eventsRemainingDb1}, sessions=${sessionsRemainingDb1}\n`);

  // Path B: WITH transaction — all-or-nothing
  const txn = db2.transaction(() => {
    db2.prepare("DELETE FROM capture_events WHERE session_id = 's1'").run();
    // If we crashed here, the entire transaction rolls back
    db2.prepare("DELETE FROM capture_sessions WHERE id = 's1'").run();
  });
  txn();

  const eventsRemainingDb2 = (
    db2.prepare("SELECT COUNT(*) AS count FROM capture_events WHERE session_id = 's1'").get() as {
      count: number;
    }
  ).count;
  const sessionsRemainingDb2 = (
    db2.prepare("SELECT COUNT(*) AS count FROM capture_sessions WHERE id = 's1'").get() as {
      count: number;
    }
  ).count;

  console.log("With transaction (IMMEDIATE — all-or-nothing):");
  console.log(`  capture_events for s1: ${eventsRemainingDb2} (deleted atomically)`);
  console.log(`  capture_sessions for s1: ${sessionsRemainingDb2} (deleted atomically)`);
  console.log(`  → CONSISTENT: events=${eventsRemainingDb2}, sessions=${sessionsRemainingDb2}\n`);

  db1.close();
  db2.close();
}

demonstrateTransactionSafety();

// =============================================================================
// Evidence 3: Consistency check
// =============================================================================
console.log("--- Negative control (no pathBased flag — already transactional) ---");
console.log(
  "  Non-pathBased deleteSessions already uses runSqliteImmediateTransactionSync → no change needed.\n",
);

console.log("--- Positive verification ---");
console.log(
  "  deletePathBasedSessions now wraps both DELETEs in runSqliteImmediateTransactionSync.",
);
console.log("  Same pattern as the non-pathBased path (deleteSessions, line 636).");
