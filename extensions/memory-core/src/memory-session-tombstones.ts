import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";

type TombstoneDatabase = {
  memory_session_tombstones: { session_id: string; agent_id: string };
};

export function ensureMemorySessionTombstones(db: DatabaseSync): void {
  if (tableExists(db, "memory_session_tombstones")) {
    return;
  }
  db.exec(`CREATE TABLE IF NOT EXISTS memory_session_tombstones (
      session_id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
}

export function hasMemorySessionTombstone(
  db: DatabaseSync,
  agentId: string,
  sessionId: string,
): boolean {
  if (!tableExists(db, "memory_session_tombstones")) {
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

type MemorySessionTombstoneRow = {
  session_id: string;
  agent_id: string;
  reason: string;
  created_at: number;
};

type MemoryOriginDatabase = {
  memory_session_tombstones: MemorySessionTombstoneRow;
  memory_index_state: { id: number; revision: number };
};
// Four bindings per row stay below SQLite's historical 999-variable default.
const TOMBSTONE_INSERT_BATCH_SIZE = 128;

/** The caller owns schema admission; preserve the supplied connection and write boundary. */
export function recordMemorySessionTombstonesInDatabase(
  db: DatabaseSync,
  params: {
    agentId: string;
    sessionIds: readonly string[];
    reason?: string;
    createdAt?: number;
  },
): number {
  const sessionIds = [...new Set(params.sessionIds)];
  if (sessionIds.length === 0) {
    return 0;
  }
  const reason = params.reason ?? "forgotten";
  const createdAt = params.createdAt ?? Date.now();
  return runSqliteImmediateTransactionSync(db, () => {
    const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
    let recorded = 0;
    for (let start = 0; start < sessionIds.length; start += TOMBSTONE_INSERT_BATCH_SIZE) {
      const result = executeSqliteQuerySync(
        db,
        kysely
          .insertInto("memory_session_tombstones")
          .values(
            sessionIds.slice(start, start + TOMBSTONE_INSERT_BATCH_SIZE).map((sessionId) => ({
              session_id: sessionId,
              agent_id: params.agentId,
              reason,
              created_at: createdAt,
            })),
          )
          .onConflict((conflict) => conflict.column("session_id").doNothing()),
      );
      recorded += Number(result.numAffectedRows ?? 0n);
    }
    if (recorded > 0) {
      // A shadow index can have no published chunks yet. Its existing revision
      // fence must still reject a rebuild prepared before this deletion.
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("memory_index_state")
          .set((expression) => ({ revision: expression("revision", "+", 1) }))
          .where("id", "=", 1),
      );
    }
    return recorded;
  });
}
