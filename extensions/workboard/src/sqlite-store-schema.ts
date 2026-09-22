import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-worker-runtime";
const SCHEMA_VERSION = 3;
const WORKBOARD_SQLITE_BUSY_TIMEOUT_MS = 5000;
const WORKBOARD_SQLITE_DIR_MODE = 0o700;
const WORKBOARD_SQLITE_FILE_MODE = 0o600;

function tableColumns(db: DatabaseSync, tableName: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
}

function ensureColumn(db: DatabaseSync, tableName: string, columnName: string, definition: string) {
  if (tableColumns(db, tableName).has(columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

const WORKBOARD_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS workboard_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workboard_boards (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      icon TEXT,
      color TEXT,
      automation_job_id TEXT,
      default_workspace_json TEXT,
      orchestration_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workboard_cards (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      agent_id TEXT,
      session_key TEXT,
      run_id TEXT,
      task_id TEXT,
      source_url TEXT,
      position REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      execution_id TEXT,
      execution_kind TEXT,
      execution_engine TEXT,
      execution_mode TEXT,
      execution_status TEXT,
      execution_model TEXT,
      execution_session_key TEXT,
      execution_run_id TEXT,
      execution_started_at INTEGER,
      execution_updated_at INTEGER,
      automation_json TEXT,
      claim_json TEXT,
      template_id TEXT,
      archived_at INTEGER,
      stale_json TEXT,
      lifecycle_status_source_updated_at INTEGER,
      failure_count INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_cards_board_status_idx
      ON workboard_cards(board_id, status, position);
    CREATE INDEX IF NOT EXISTS workboard_cards_session_idx
      ON workboard_cards(session_key, run_id);

    CREATE TABLE IF NOT EXISTS workboard_card_labels (
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      label TEXT NOT NULL,
      PRIMARY KEY(card_id, ordinal)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workboard_card_events (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT,
      session_key TEXT,
      run_id TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_events_card_idx
      ON workboard_card_events(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_card_attempts (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      engine TEXT,
      mode TEXT,
      model TEXT,
      session_key TEXT,
      run_id TEXT,
      error TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_attempts_card_idx
      ON workboard_card_attempts(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_card_comments (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_comments_card_idx
      ON workboard_card_comments(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_card_links (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      type TEXT NOT NULL,
      target_card_id TEXT,
      title TEXT,
      url TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_links_card_idx
      ON workboard_card_links(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_card_proof (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      label TEXT,
      command TEXT,
      url TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_proof_card_idx
      ON workboard_card_proof(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_card_artifacts (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      label TEXT,
      url TEXT,
      path TEXT,
      mime_type TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_artifacts_card_idx
      ON workboard_card_artifacts(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_card_diagnostics (
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      count INTEGER NOT NULL,
      actions_json TEXT NOT NULL,
      PRIMARY KEY(card_id, ordinal)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workboard_card_notifications (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sequence INTEGER,
      session_key TEXT,
      run_id TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_notifications_card_idx
      ON workboard_card_notifications(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_worker_logs (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      session_key TEXT,
      run_id TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_worker_logs_card_idx
      ON workboard_worker_logs(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_worker_protocol (
      card_id TEXT PRIMARY KEY REFERENCES workboard_cards(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      detail TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workboard_card_attachments (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      mime_type TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_attachments_card_idx
      ON workboard_card_attachments(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_attachment_blobs (
      attachment_id TEXT PRIMARY KEY,
      content BLOB NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workboard_notification_subscriptions (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      card_id TEXT,
      session_key TEXT,
      run_id TEXT,
      target TEXT,
      event_kinds_json TEXT,
      last_event_at INTEGER,
      last_event_id TEXT,
      last_event_sequence INTEGER,
      delivered_event_ids_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
  `;

function ensureWorkboardSchema(db: DatabaseSync): void {
  db.exec(WORKBOARD_SCHEMA_SQL);
  ensureColumn(db, "workboard_boards", "automation_job_id", "automation_job_id TEXT");
  ensureColumn(
    db,
    "workboard_cards",
    "lifecycle_status_source_updated_at",
    "lifecycle_status_source_updated_at INTEGER",
  );
  const migrationId = `schema-${SCHEMA_VERSION}`;
  const current = db
    .prepare("SELECT 1 AS found FROM workboard_schema_migrations WHERE id = ?")
    .get(migrationId);
  if (!current) {
    migrateSqliteSchemaToStrict(db, WORKBOARD_SCHEMA_SQL, {
      databaseLabel: "workboard database",
    });
    db.prepare(
      "INSERT OR IGNORE INTO workboard_schema_migrations (id, applied_at) VALUES (?, ?)",
    ).run(migrationId, Date.now());
  }
}

function chmodIfExists(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (err) {
    // SAFETY: chmodSync reports filesystem failures as Node errno exceptions.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function hardenWorkboardDatabaseFiles(dbPath: string): void {
  fs.chmodSync(path.dirname(dbPath), WORKBOARD_SQLITE_DIR_MODE);
  chmodIfExists(dbPath, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-wal`, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-shm`, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-journal`, WORKBOARD_SQLITE_FILE_MODE);
}

function prepareWorkboardDatabasePath(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: WORKBOARD_SQLITE_DIR_MODE });
  chmodIfExists(path.dirname(dbPath), WORKBOARD_SQLITE_DIR_MODE);
  if (!fs.existsSync(dbPath)) {
    fs.closeSync(fs.openSync(dbPath, "a", WORKBOARD_SQLITE_FILE_MODE));
  }
}

export function createWorkboardDatabase(
  dbPath: string,
  retainClose?: (close: () => void) => void,
): {
  db: DatabaseSync;
  close: () => void;
} {
  prepareWorkboardDatabasePath(dbPath);
  const db = openNodeSqliteDatabase(dbPath);
  let maintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
  let maintenanceClosed = false;
  let databaseClosed = false;
  const close = () => {
    if (!maintenanceClosed) {
      maintenance?.close();
      maintenanceClosed = true;
    }
    if (!databaseClosed) {
      db.close();
      databaseClosed = true;
    }
  };
  try {
    retainClose?.(close);
    maintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: WORKBOARD_SQLITE_BUSY_TIMEOUT_MS,
      checkpointIntervalMs: 0,
      databaseLabel: "workboard database",
      databasePath: dbPath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    ensureWorkboardSchema(db);
    hardenWorkboardDatabaseFiles(dbPath);
    return { db, close };
  } catch (error) {
    if (!retainClose) {
      try {
        maintenance?.close();
      } finally {
        db.close();
      }
    }
    throw error;
  }
}
