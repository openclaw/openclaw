import type { CwDatabase } from "./db-types.js";

/** Idempotent schema migrations for SQLite and PostgreSQL. */
export function migrateClaworksSchema(db: CwDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cw_outbox (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      is_dead INTEGER NOT NULL DEFAULT 0
    );
  `);

  addColumnIfMissing(db, "cw_events", "subject_id", "TEXT");
  addColumnIfMissing(db, "cw_events", "subject_type", "TEXT");
  addColumnIfMissing(db, "cw_events", "idempotency_key", "TEXT");
  addColumnIfMissing(db, "cw_outbox", "is_dead", "INTEGER NOT NULL DEFAULT 0");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_playbook ON cw_playbook_runs(playbook_id);
    CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_status ON cw_playbook_runs(status);
    CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_started ON cw_playbook_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cw_events_type ON cw_events(type);
    CREATE INDEX IF NOT EXISTS idx_cw_events_timestamp ON cw_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_cw_outbox_due ON cw_outbox(next_attempt_at) WHERE is_dead = 0;
  `);
}

function addColumnIfMissing(db: CwDatabase, table: string, column: string, ddl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch {
    // column already exists
  }
}
