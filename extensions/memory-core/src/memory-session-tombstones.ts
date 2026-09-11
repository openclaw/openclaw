import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-runtime";

type TombstoneDatabase = {
  memory_session_tombstones: { session_id: string; agent_id: string };
};

const ensuredDatabases = new WeakSet<DatabaseSync>();

export function memorySessionTombstonesExist(db: DatabaseSync): boolean {
  return ensuredDatabases.has(db) || tableExists(db, "memory_session_tombstones");
}

export function ensureMemorySessionTombstones(db: DatabaseSync): void {
  if (ensuredDatabases.has(db)) {
    return;
  }
  db.exec(`CREATE TABLE IF NOT EXISTS memory_session_tombstones (
      session_id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
  ensuredDatabases.add(db);
}

export function hasMemorySessionTombstone(
  db: DatabaseSync,
  agentId: string,
  sessionId: string,
): boolean {
  if (!memorySessionTombstonesExist(db)) {
    return false;
  }
  return (
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<TombstoneDatabase>(db)
        .selectFrom("memory_session_tombstones")
        .select("session_id")
        .where("agent_id", "=", agentId)
        .where("session_id", "=", sessionId),
    ).rows.length > 0
  );
}
