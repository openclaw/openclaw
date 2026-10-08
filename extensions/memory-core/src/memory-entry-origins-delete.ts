import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
  sqliteStringSet,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { MemoryOriginDeletion } from "./memory-entry-origins-task.js";

type OriginDatabase = {
  memory_entry_origins: { entry_key: string; agent_id: string; session_id: string };
};

/** Forget retains its supplied connection and original transaction boundary. */
export function deleteMemoryEntryOriginsInDatabase(
  db: DatabaseSync,
  params: MemoryOriginDeletion,
  admission?: { onBegin: () => void; withCommit: (commit: () => void) => void },
): number {
  if (
    params.entryKeys.length === 0 ||
    params.sessionIds?.length === 0 ||
    !tableExists(db, "memory_entry_origins")
  ) {
    return 0;
  }
  return runSqliteImmediateTransactionSync(
    db,
    () => {
      admission?.onBegin();
      let query = getNodeSqliteKysely<OriginDatabase>(db)
        .deleteFrom("memory_entry_origins")
        .where("agent_id", "=", params.agentId)
        .where("entry_key", "in", sqliteStringSet(params.entryKeys));
      if (params.sessionIds) {
        query = query.where("session_id", "in", sqliteStringSet(params.sessionIds));
      }
      return Number(executeSqliteQuerySync(db, query).numAffectedRows ?? 0n);
    },
    admission && { withCommit: admission.withCommit },
  );
}
