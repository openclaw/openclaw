import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../../../../../src/infra/node-sqlite.js";
import { migrateClaworksSchema } from "./db-migrate.js";

export type { CwDatabase } from "./db-types.js";
import type { CwDatabase } from "./db-types.js";

export function openDatabase(databaseUrl: string): { db: CwDatabase; close: () => void } {
  const path = databaseUrl.startsWith("sqlite://")
    ? databaseUrl.slice("sqlite://".length)
    : databaseUrl;
  mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cw_objects (
      id TEXT NOT NULL,
      type_name TEXT NOT NULL,
      data TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
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
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS cw_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      payload TEXT NOT NULL,
      correlation_id TEXT,
      timestamp INTEGER NOT NULL,
      subject_id TEXT,
      subject_type TEXT,
      idempotency_key TEXT
    );
  `);
  migrateClaworksSchema(db);
  return {
    db,
    close: () => db.close(),
  };
}
