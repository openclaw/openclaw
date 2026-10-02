import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "./host/openclaw-runtime-kysely.js";

export type MemoryEntryOrigin = {
  entryKey: string;
  agentId: string;
  sessionId: string;
  sessionKey: string | null;
  originClass: "owner" | "agent" | "untrusted" | "system";
  observedAt: number;
};

type MemoryEntryOriginRow = {
  entry_key: string;
  agent_id: string;
  session_id: string;
  session_key: string | null;
  origin_class: MemoryEntryOrigin["originClass"];
  observed_at: number;
};

type MemoryOriginDatabase = { memory_entry_origins: MemoryEntryOriginRow };

export function ensureMemoryEntryOriginsSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_entry_origins (
    entry_key TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    session_key TEXT,
    origin_class TEXT NOT NULL CHECK (origin_class IN ('owner', 'agent', 'untrusted', 'system')),
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (entry_key, agent_id, session_id)
  ) STRICT`);
}

function readOrigin(row: MemoryEntryOriginRow): MemoryEntryOrigin {
  return {
    entryKey: row.entry_key,
    agentId: row.agent_id,
    sessionId: row.session_id,
    sessionKey: row.session_key,
    originClass: row.origin_class,
    observedAt: row.observed_at,
  };
}

export function readMemoryEntryOriginsInDatabase(
  db: DatabaseSync,
  params: { agentId: string; sessionIds?: readonly string[]; entryKeys?: readonly string[] },
): MemoryEntryOrigin[] {
  const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
  let query = kysely
    .selectFrom("memory_entry_origins")
    .selectAll()
    .where("agent_id", "=", params.agentId);
  if (params.sessionIds) {
    query = query.where("session_id", "in", params.sessionIds);
  }
  if (params.entryKeys) {
    query = query.where("entry_key", "in", params.entryKeys);
  }
  return executeSqliteQuerySync(
    db,
    query.orderBy("entry_key", "asc").orderBy("session_id", "asc"),
  ).rows.map(readOrigin);
}

/** The caller owns schema admission and the synchronous transaction. */
export function recordMemoryEntryOriginsInDatabase(
  db: DatabaseSync,
  params: { agentId: string; origins: readonly MemoryEntryOrigin[]; entryKey?: string },
): MemoryEntryOrigin[] {
  const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
  let insert:
    | ReturnType<typeof prepareSqliteQuerySync<MemoryEntryOrigin, MemoryEntryOriginRow>>
    | undefined;
  return params.origins.flatMap((origin) => {
    if (origin.agentId !== params.agentId) {
      throw new Error("memory entry origin belongs to another agent");
    }
    insert ??= prepareSqliteQuerySync<MemoryEntryOrigin, MemoryEntryOriginRow>(db, (parameter) =>
      kysely
        .insertInto("memory_entry_origins")
        .values({
          entry_key: parameter((value) => params.entryKey ?? value.entryKey),
          agent_id: parameter((value) => value.agentId),
          session_id: parameter((value) => value.sessionId),
          session_key: parameter((value) => value.sessionKey),
          origin_class: parameter((value) => value.originClass),
          observed_at: parameter((value) => value.observedAt),
        })
        .onConflict((conflict) =>
          conflict.columns(["entry_key", "agent_id", "session_id"]).doNothing(),
        )
        .returningAll(),
    );
    return insert(origin).rows.map(readOrigin);
  });
}
