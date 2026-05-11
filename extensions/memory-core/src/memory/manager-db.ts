import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  ensureDir,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { ensureOpenClawAgentDatabaseSchema } from "openclaw/plugin-sdk/sqlite-runtime";

export const MEMORY_SQLITE_BUSY_TIMEOUT_MS = 30_000;

export function openMemoryDatabaseAtPath(
  dbPath: string,
  allowExtension: boolean,
  agentId?: string,
): DatabaseSync {
  const dir = path.dirname(dbPath);
  ensureDir(dir);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { allowExtension });
  configureMemorySqliteWalMaintenance(db, {
    databaseLabel: "memory-agent",
    databasePath: dbPath,
  });
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // busy_timeout is per-connection and resets to 0 on restart.
  // Set it on every open so concurrent processes retry instead of
  // failing immediately with SQLITE_BUSY.
  db.exec(`PRAGMA busy_timeout = ${MEMORY_SQLITE_BUSY_TIMEOUT_MS}`);
  if (agentId) {
    ensureOpenClawAgentDatabaseSchema(db, { agentId, path: dbPath, register: true });
  }
  return db;
}

export function closeMemoryDatabase(db: DatabaseSync): void {
  closeMemorySqliteWalMaintenance(db);
  db.close();
}
