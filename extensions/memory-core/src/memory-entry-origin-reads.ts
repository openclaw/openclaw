import type { DatabaseSync } from "node:sqlite";
import { readMemoryEntryOriginsInDatabase } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  tableExists,
  withFreshOpenClawAgentDatabaseReadOnly,
} from "openclaw/plugin-sdk/sqlite-runtime";
import type { MemoryOriginReadInput, MemoryOriginReadOutput } from "./memory-entry-origins-task.js";
import { extractPromotionKeys } from "./short-term-promotion-memory-write.js";

type OriginReadDatabase = {
  memory_entry_origins: { entry_key: string; agent_id: string; session_id: string };
  memory_session_tombstones: {
    session_id: string;
    agent_id: string;
    reason: string;
    created_at: number;
  };
  memory_index_chunks: { text: string; source: string };
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
        .where("entry_key", "in", request.entryKeys);
      if (request.sessionIds) {
        query = query.where("session_id", "in", request.sessionIds);
      }
      exists = executeSqliteQuerySync(db, query.limit(1)).rows.length > 0;
    }
    return { kind: request.kind, exists };
  }
  if (request.kind === "session-tombstones") {
    if (!db || !tableExists(db, "memory_session_tombstones")) {
      return { kind: request.kind, rows: [] };
    }
    let query = getNodeSqliteKysely<OriginReadDatabase>(db)
      .selectFrom("memory_session_tombstones")
      .selectAll()
      .where("agent_id", "=", request.agentId);
    if (request.sessionIds) {
      query = query.where("session_id", "in", request.sessionIds);
    }
    return {
      kind: request.kind,
      rows: executeSqliteQuerySync(db, query.orderBy("session_id", "asc")).rows.map((row) => ({
        sessionId: row.session_id,
        agentId: row.agent_id,
        reason: row.reason,
        createdAt: row.created_at,
      })),
    };
  }
  const keys = db
    ? executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<OriginReadDatabase>(db)
          .selectFrom("memory_index_chunks")
          .select("text")
          .where("source", "=", "memory")
          .where("text", "like", "%openclaw-memory-promotion:%"),
      ).rows.flatMap(({ text }) => extractPromotionKeys(text))
    : [];
  return { kind: request.kind, keys };
}

export function readMemoryOriginsInWorker(request: MemoryOriginReadInput): MemoryOriginReadOutput {
  const result = withFreshOpenClawAgentDatabaseReadOnly(({ db }) => queryOrigins(db, request), {
    agentId: request.agentId,
    path: request.databasePath,
    env: { OPENCLAW_STATE_DIR: request.stateDir },
  });
  return result.found ? result.value : queryOrigins(undefined, request);
}
