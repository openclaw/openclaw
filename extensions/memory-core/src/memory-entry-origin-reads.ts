import type { DatabaseSync } from "node:sqlite";
import {
  encodeSqliteStringSet,
  readMemoryEntryOriginsInDatabase,
  sqliteStringSetEntries,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { withFreshOpenClawAgentDatabaseReadOnly } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  MEMORY_SESSION_TOMBSTONE_BATCH_SIZE,
  type MemoryOriginReadInput,
  type MemoryOriginReadOutput,
} from "./memory-entry-origins-task.js";

type OriginReadDatabase = {
  memory_entry_origins: { entry_key: string; agent_id: string; session_id: string };
  memory_session_tombstones: { session_id: string; agent_id: string };
};

function queryOrigins(
  db: DatabaseSync | undefined,
  request: MemoryOriginReadInput,
): MemoryOriginReadOutput {
  if (request.kind === "origin-rows") {
    return {
      kind: request.kind,
      rows:
        db && tableExists(db, "memory_entry_origins")
          ? readMemoryEntryOriginsInDatabase(db, request)
          : [],
    };
  }
  if (request.kind === "origin-exists") {
    let exists = false;
    if (db && tableExists(db, "memory_entry_origins")) {
      let query = getNodeSqliteKysely<OriginReadDatabase>(db)
        .selectFrom("memory_entry_origins")
        .select("entry_key")
        .where("agent_id", "=", request.agentId)
        .where("entry_key", "in", sqliteStringSet(request.entryKeys));
      if (request.sessionIds) {
        query = query.where("session_id", "in", sqliteStringSet(request.sessionIds));
      }
      exists = executeSqliteQuerySync(db, query.limit(1)).rows.length > 0;
    }
    return { kind: request.kind, exists };
  }
  if (!db || !tableExists(db, "memory_session_tombstones")) {
    return { kind: request.kind, indices: [] };
  }
  const query = getNodeSqliteKysely<OriginReadDatabase>(db)
    .selectFrom(sqliteStringSetEntries(encodeSqliteStringSet(request.sessionIds)).as("selected"))
    .select("selected.key")
    .where("selected.key", "<", MEMORY_SESSION_TOMBSTONE_BATCH_SIZE)
    .where((expression) =>
      expression.exists(
        expression
          .selectFrom("memory_session_tombstones")
          .select("session_id")
          .where("agent_id", "=", request.agentId)
          .whereRef("session_id", "=", "selected.value"),
      ),
    )
    .orderBy("selected.key", "asc")
    .limit(MEMORY_SESSION_TOMBSTONE_BATCH_SIZE);
  return {
    kind: request.kind,
    indices: executeSqliteQuerySync(db, query).rows.map((row) => row.key),
  };
}

export function readMemoryOriginsInWorker(request: MemoryOriginReadInput): MemoryOriginReadOutput {
  const result = withFreshOpenClawAgentDatabaseReadOnly(({ db }) => queryOrigins(db, request), {
    agentId: request.agentId,
    path: request.databasePath,
    env: { OPENCLAW_STATE_DIR: request.stateDir },
  });
  return result.found ? result.value : queryOrigins(undefined, request);
}
