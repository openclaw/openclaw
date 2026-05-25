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
    CREATE TABLE IF NOT EXISTS cw_user_profiles (
      user_id TEXT PRIMARY KEY,
      name TEXT,
      preferred_language TEXT,
      preferred_style TEXT NOT NULL DEFAULT 'concise',
      recent_topics TEXT NOT NULL DEFAULT '[]',
      interaction_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL,
      custom_notes TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cw_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      actor TEXT,
      target TEXT,
      payload TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cw_audit_log_type ON cw_audit_log(event_type);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cw_evolution_pending_promotions (
      promotion_id TEXT PRIMARY KEY,
      pack_json TEXT NOT NULL,
      playbook_ids TEXT NOT NULL,
      simulation_results TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      registered_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cw_evolution_pending_status
      ON cw_evolution_pending_promotions(status);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_playbook ON cw_playbook_runs(playbook_id);
    CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_status ON cw_playbook_runs(status);
    CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_started ON cw_playbook_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cw_events_type ON cw_events(type);
    CREATE INDEX IF NOT EXISTS idx_cw_events_timestamp ON cw_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_cw_outbox_due ON cw_outbox(next_attempt_at) WHERE is_dead = 0;
    CREATE INDEX IF NOT EXISTS idx_cw_objects_type_created ON cw_objects(type_name, created_at DESC);
  `);
}

function addColumnIfMissing(db: CwDatabase, table: string, column: string, ddl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch {
    // column already exists
  }
}
