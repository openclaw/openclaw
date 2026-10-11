import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  getSqliteDatabaseAdmission,
  openNodeSqliteDatabase,
  publishSqliteDatabaseAdmission,
  type SqlConnection,
  type SqliteDatabaseAdmissionKey,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { openWorkboardPostgresDatabase } from "./postgres-store.js";
import { SCHEMA_VERSION, WORKBOARD_SCHEMA_SQL } from "./workboard-schema.js";
const WORKBOARD_SQLITE_BUSY_TIMEOUT_MS = 5000;
const WORKBOARD_SQLITE_DIR_MODE = 0o700;
const WORKBOARD_SQLITE_FILE_MODE = 0o600;
const schemaAdmission: SqliteDatabaseAdmissionKey<true> = {
  name: "workboard.schema",
  schemaDependent: true,
  read: (value) => (value === true ? true : undefined),
};

function refusePostgresAnchor(db: DatabaseSync): void {
  try {
    const anchor = db.prepare("SELECT schema FROM openclaw_engine_anchor LIMIT 1").get();
    throw new Error(
      `This workboard store lives in PostgreSQL schema ${String(anchor?.schema ?? "unknown")}; set OPENCLAW_EXPERIMENTAL_POSTGRES_URL.`,
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "no such table: openclaw_engine_anchor") {
      throw error;
    }
  }
}

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

function ensureWorkboardSchema(db: DatabaseSync): void {
  if (getSqliteDatabaseAdmission(db, schemaAdmission)) {
    return;
  }
  db.exec(WORKBOARD_SCHEMA_SQL);
  ensureColumn(db, "workboard_boards", "automation_job_id", "automation_job_id TEXT");
  ensureColumn(db, "workboard_boards", "kind", "kind TEXT");
  ensureColumn(db, "workboard_boards", "sessions_spec", "sessions_spec TEXT");
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
  publishSqliteDatabaseAdmission(db, schemaAdmission, true);
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
  db: SqlConnection;
  close: () => void;
} {
  prepareWorkboardDatabasePath(dbPath);
  const db = openNodeSqliteDatabase(dbPath);
  let postgres: ReturnType<typeof openWorkboardPostgresDatabase> | undefined;
  let maintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
  let maintenanceClosed = false;
  let databaseClosed = false;
  const close = () => {
    postgres?.close();
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
    if (!process.env.OPENCLAW_EXPERIMENTAL_POSTGRES_URL) {
      refusePostgresAnchor(db);
    }
    maintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: WORKBOARD_SQLITE_BUSY_TIMEOUT_MS,
      checkpointIntervalMs: 0,
      databaseLabel: "workboard database",
      databasePath: dbPath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    if (process.env.OPENCLAW_EXPERIMENTAL_POSTGRES_URL) {
      postgres = openWorkboardPostgresDatabase(db, process.env.OPENCLAW_EXPERIMENTAL_POSTGRES_URL);
    } else {
      ensureWorkboardSchema(db);
    }
    hardenWorkboardDatabaseFiles(dbPath);
    return { db: postgres ?? db, close };
  } catch (error) {
    if (!retainClose) {
      try {
        postgres?.close();
        maintenance?.close();
      } finally {
        db.close();
      }
    }
    throw error;
  }
}
