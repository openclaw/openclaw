import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryEntryOriginsSchema,
  readMemoryEntryOriginsInDatabase,
  recordMemoryEntryOriginsInDatabase,
  type MemoryEntryOrigin,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawAgentDatabase,
  runSqliteImmediateTransactionSync,
  tableExists,
  withOpenClawAgentDatabaseReadOnly,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { DREAMS_FILENAMES, readDreamsFile } from "./dreaming-dreams-file.js";
import {
  ensureMemorySessionTombstones,
  memorySessionTombstonesExist,
} from "./memory-session-tombstones.js";
import { extractPromotionKeys } from "./short-term-promotion-memory-write.js";

export type { MemoryEntryOrigin };

type MemorySessionTombstone = {
  sessionId: string;
  agentId: string;
  reason: string;
  createdAt: number;
};

type MemorySessionTombstoneRow = {
  session_id: string;
  agent_id: string;
  reason: string;
  created_at: number;
};

type MemoryOriginDatabase = {
  memory_entry_origins: { entry_key: string; agent_id: string; session_id: string };
  memory_session_tombstones: MemorySessionTombstoneRow;
  memory_index_state: { id: number; revision: number };
  memory_index_chunks: { text: string; source: string };
};
// Four bindings per row stay below SQLite's historical 999-variable default.
const TOMBSTONE_INSERT_BATCH_SIZE = 128;
const ensuredDatabases = new WeakSet<DatabaseSync>();

function openMemoryOriginDatabase(agentId: string): DatabaseSync {
  const db = openOpenClawAgentDatabase({ agentId }).db;
  if (!ensuredDatabases.has(db)) {
    ensureMemoryEntryOriginsSchema(db);
    ensuredDatabases.add(db);
  }
  return db;
}

export function listMemoryEntryOrigins(params: {
  agentId: string;
  sessionIds?: readonly string[];
  entryKeys?: readonly string[];
}): MemoryEntryOrigin[] {
  if (params.sessionIds?.length === 0 || params.entryKeys?.length === 0) {
    return [];
  }
  const result = withOpenClawAgentDatabaseReadOnly(({ db }) => {
    if (!ensuredDatabases.has(db) && !tableExists(db, "memory_entry_origins")) {
      return [];
    }
    return readMemoryEntryOriginsInDatabase(db, params);
  }, params);
  return result.found ? result.value : [];
}

export function listMemorySessionTombstones(params: {
  agentId: string;
  sessionIds?: readonly string[];
}): MemorySessionTombstone[] {
  if (params.sessionIds?.length === 0) {
    return [];
  }
  const result = withOpenClawAgentDatabaseReadOnly(({ db }) => {
    if (!memorySessionTombstonesExist(db)) {
      return [];
    }
    const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
    let query = kysely
      .selectFrom("memory_session_tombstones")
      .selectAll()
      .where("agent_id", "=", params.agentId);
    if (params.sessionIds) {
      query = query.where("session_id", "in", params.sessionIds);
    }
    return executeSqliteQuerySync(db, query.orderBy("session_id", "asc")).rows.map((row) => ({
      sessionId: row.session_id,
      agentId: row.agent_id,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }, params);
  return result.found ? result.value : [];
}

/** Record on the supplied connection; the caller retains write admission. */
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
  ensureMemorySessionTombstones(db);
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

export function recordMemoryEntryOrigins(params: {
  agentId: string;
  origins: readonly MemoryEntryOrigin[];
  entryKey?: string;
}): MemoryEntryOrigin[] {
  if (params.origins.length === 0) {
    return [];
  }
  const db = openMemoryOriginDatabase(params.agentId);
  return runSqliteImmediateTransactionSync(db, () =>
    recordMemoryEntryOriginsInDatabase(db, params),
  );
}

function deleteMemoryEntryOrigins(params: {
  agentId: string;
  entryKeys: readonly string[];
  sessionIds?: readonly string[];
}): number {
  if (params.entryKeys.length === 0 || params.sessionIds?.length === 0) {
    return 0;
  }
  const existing = withOpenClawAgentDatabaseReadOnly(({ db }) => {
    if (!ensuredDatabases.has(db) && !tableExists(db, "memory_entry_origins")) {
      return false;
    }
    let query = getNodeSqliteKysely<MemoryOriginDatabase>(db)
      .selectFrom("memory_entry_origins")
      .select("entry_key")
      .where("agent_id", "=", params.agentId)
      .where("entry_key", "in", params.entryKeys);
    if (params.sessionIds) {
      query = query.where("session_id", "in", params.sessionIds);
    }
    return executeSqliteQuerySync(db, query.limit(1)).rows.length > 0;
  }, params);
  if (!existing.found || !existing.value) {
    return 0;
  }
  return deleteMemoryEntryOriginsInDatabase(openMemoryOriginDatabase(params.agentId), params);
}

/** Mutate only the supplied connection; callers retain its admission and lifetime. */
export function deleteMemoryEntryOriginsInDatabase(
  db: DatabaseSync,
  params: { agentId: string; entryKeys: readonly string[]; sessionIds?: readonly string[] },
): number {
  if (
    params.entryKeys.length === 0 ||
    params.sessionIds?.length === 0 ||
    !tableExists(db, "memory_entry_origins")
  ) {
    return 0;
  }
  return runSqliteImmediateTransactionSync(db, () => {
    const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
    let query = kysely
      .deleteFrom("memory_entry_origins")
      .where("agent_id", "=", params.agentId)
      .where("entry_key", "in", params.entryKeys);
    if (params.sessionIds) {
      query = query.where("session_id", "in", params.sessionIds);
    }
    return Number(executeSqliteQuerySync(db, query).numAffectedRows ?? 0n);
  });
}

export function reserveMemoryEntryOrigins(params: {
  agentIds: readonly string[];
  previousMemory: string;
  operations: readonly {
    candidateKey: string;
    action: "added" | "merged" | "superseded";
    priorEntries: readonly string[];
  }[];
}): () => void {
  const previousLines = params.previousMemory.replace(/\r\n/gu, "\n").split("\n");
  const operationParents = params.operations.map((operation) => {
    const parentKeys = new Set([operation.candidateKey]);
    for (const entry of operation.priorEntries) {
      const entryIndex = previousLines.findIndex((line) => line.trim() === entry);
      const marker = previousLines[entryIndex - 1]?.trim();
      const parentKey = /^<!--\s*openclaw-memory-promotion:([^\n]*?)\s*-->$/u
        .exec(marker ?? "")?.[1]
        ?.trim();
      if (parentKey) {
        parentKeys.add(parentKey);
      }
    }
    return { operation, parentKeys };
  });
  const affectedKeys = [...new Set(operationParents.flatMap(({ parentKeys }) => [...parentKeys]))];
  const reservations: Array<Parameters<typeof deleteMemoryEntryOrigins>[0]> = [];
  const rollback = () => {
    for (const reservation of reservations.toReversed()) {
      deleteMemoryEntryOrigins(reservation);
    }
  };
  try {
    for (const agentId of [...new Set(params.agentIds)].toSorted()) {
      const origins = listMemoryEntryOrigins({ agentId, entryKeys: affectedKeys });
      for (const { operation, parentKeys } of operationParents) {
        const added = recordMemoryEntryOrigins({
          agentId,
          origins: origins.filter((origin) => parentKeys.has(origin.entryKey)),
          entryKey: operation.candidateKey,
        });
        if (added.length > 0) {
          reservations.push({
            agentId,
            entryKeys: [operation.candidateKey],
            sessionIds: added.map((origin) => origin.sessionId),
          });
        }
      }
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return rollback;
}

export async function pruneMemoryEntryOrigins(params: {
  workspaceDir: string;
  agentIds: readonly string[];
  entryKeys: Iterable<string>;
  retainedEntryKeys: ReadonlySet<string>;
}): Promise<void> {
  const entryKeys = [...new Set(params.entryKeys)].filter(
    (key) => !params.retainedEntryKeys.has(key),
  );
  if (entryKeys.length === 0) {
    return;
  }
  // Keep diary origins through backup rotation; callers hold the workspace lock.
  const diaries = await Promise.all(
    DREAMS_FILENAMES.map((name) =>
      readDreamsFile(path.join(params.workspaceDir, name), params.workspaceDir),
    ),
  );
  const diaryKeys = new Set(diaries.flatMap(extractPromotionKeys));
  for (const agentId of new Set(params.agentIds)) {
    // A sibling may still index an older shared MEMORY snapshot. Retain its
    // lineage until that agent can identify and purge those derived records.
    const indexed = withOpenClawAgentDatabaseReadOnly(
      ({ db }) =>
        new Set(
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<MemoryOriginDatabase>(db)
              .selectFrom("memory_index_chunks")
              .select("text")
              .where("source", "=", "memory")
              .where("text", "like", "%openclaw-memory-promotion:%"),
          ).rows.flatMap(({ text }) => extractPromotionKeys(text)),
        ),
      { agentId },
    );
    deleteMemoryEntryOrigins({
      agentId,
      entryKeys: entryKeys.filter(
        (key) => !diaryKeys.has(key) && !(indexed.found && indexed.value.has(key)),
      ),
    });
  }
}
