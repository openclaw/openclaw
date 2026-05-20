import { homedir } from "node:os";
import { join } from "node:path";
import { migrateClaworksSchema } from "./db-migrate.js";
import { isPostgresDatabaseUrl, openPostgresDatabase } from "./db-pg.js";
import type { CwDatabase } from "./db-types.js";
import { openDatabase as openSqliteDatabase } from "./db.js";

export type OpenDatabaseResult = {
  db: CwDatabase;
  close: () => void;
  dialect: "sqlite" | "postgresql";
  note?: string;
};

const PG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cw_objects (
  id TEXT NOT NULL,
  type_name TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id, type_name)
);
CREATE INDEX IF NOT EXISTS idx_cw_objects_type ON cw_objects(type_name);

CREATE TABLE IF NOT EXISTS cw_playbook_runs (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  error TEXT,
  steps TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  completed_at BIGINT
);

CREATE TABLE IF NOT EXISTS cw_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  correlation_id TEXT,
  timestamp BIGINT NOT NULL,
  subject_id TEXT,
  subject_type TEXT,
  idempotency_key TEXT
);
`;

function bootstrapPgSchema(db: CwDatabase): void {
  for (const stmt of PG_SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    db.exec(stmt);
  }
  migrateClaworksSchema(db);
}

/**
 * Open ClaWorks persistence (SQLite or PostgreSQL).
 */
export function openDatabase(databaseUrl: string): OpenDatabaseResult {
  const url = databaseUrl.trim();

  if (isPostgresDatabaseUrl(url)) {
    try {
      const pg = openPostgresDatabase(url);
      bootstrapPgSchema(pg.db);
      return { ...pg, dialect: "postgresql" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("Cannot find package 'pg'")) {
        throw err;
      }
      const cachePath = join(homedir(), ".claworks", "pg-runtime-cache.db");
      const sqlite = openSqliteDatabase(`sqlite://${cachePath}`);
      return {
        ...sqlite,
        dialect: "postgresql",
        note:
          `PostgreSQL requested but optional dependency 'pg' is not installed (${message}). ` +
          "Install with: pnpm add -w pg. Using SQLite cache for this session.",
      };
    }
  }

  const sqlite = openSqliteDatabase(url);
  return { ...sqlite, dialect: "sqlite" };
}
