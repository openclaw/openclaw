import type Database from "better-sqlite3";

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        user_prompt_preview TEXT,
        assistant_response_preview TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        tool_calls_json TEXT,
        plugins_triggered_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS plugin_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id INTEGER REFERENCES turns(id),
        plugin_id TEXT NOT NULL,
        detection_method TEXT NOT NULL,
        action TEXT,
        metadata_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS satisfaction_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id INTEGER REFERENCES turns(id),
        signal_type TEXT NOT NULL,
        confidence REAL,
        next_turn_id INTEGER REFERENCES turns(id),
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS llm_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id INTEGER REFERENCES turns(id),
        accuracy_score REAL,
        completeness_score REAL,
        relevance_score REAL,
        overall_score REAL,
        judge_model TEXT,
        judge_response_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tool_plugin_mapping (
        tool_name TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        plugin_name TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS plugin_installs (
        plugin_id TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
      CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp);
      CREATE INDEX IF NOT EXISTS idx_plugin_events_plugin ON plugin_events(plugin_id);
      CREATE INDEX IF NOT EXISTS idx_plugin_events_turn ON plugin_events(turn_id);
      CREATE INDEX IF NOT EXISTS idx_satisfaction_turn ON satisfaction_signals(turn_id);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS observed_unmapped_tools (
        tool_name TEXT PRIMARY KEY,
        call_count INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT DEFAULT (datetime('now')),
        last_seen_at TEXT DEFAULT (datetime('now'))
      );
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT version FROM _migrations")
      .all()
      .map((row: any) => row.version as number),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(migration.version);
    })();
  }
}
