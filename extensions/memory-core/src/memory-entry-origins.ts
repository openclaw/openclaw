import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  readMemoryEntryOriginsInDatabase,
  type MemoryEntryOrigin,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawAgentSqliteWorkerStore,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteAdmission,
  runSqliteImmediateTransactionSync,
  tableExists,
  withOpenClawAgentDatabaseAsync,
  withOpenClawAgentDatabaseReadOnly,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { DREAMS_FILENAMES, readDreamsFile } from "./dreaming-dreams-file.js";
import type {
  MemoryEntryOriginOperations,
  MemoryOriginDeletion,
  MemoryOriginRecord,
} from "./memory-entry-origins-task.js";
import {
  ensureMemorySessionTombstones,
  memorySessionTombstonesExist,
} from "./memory-session-tombstones.js";
import { memoryCpuProcessEntrypoints } from "./memory/manager-cpu-entrypoints.js";
import { extractPromotionKeys } from "./short-term-promotion-memory-write.js";

export type { MemoryEntryOrigin };
export { deleteMemoryEntryOriginsInDatabase } from "./memory-entry-origins-delete.js";

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
type OriginDatabaseOptions = ReturnType<typeof captureOriginDatabaseOptions>;

function captureOriginDatabaseOptions(agentId: string) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: resolveStateDir() };
  return { agentId, env, path: resolveOpenClawAgentSqlitePath({ agentId, env }) };
}

async function executeOriginCommand<Key extends keyof MemoryEntryOriginOperations>(
  options: OriginDatabaseOptions,
  command: { type: Key; input: MemoryEntryOriginOperations[Key]["input"] },
  assertOriginal?: () => void,
): Promise<MemoryEntryOriginOperations[Key]["output"]> {
  assertOriginal?.();
  return runOpenClawAgentWriteAdmission(
    options,
    async (_identity, assertAdmission) => {
      const assertCurrent = () => {
        assertOriginal?.();
        assertAdmission();
      };
      return withOpenClawAgentDatabaseAsync(
        options,
        async ({ db }) => {
          const worker = await openOpenClawAgentSqliteWorkerStore<MemoryEntryOriginOperations>(
            options,
            db,
            {
              moduleUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.entryOrigins),
              input: undefined,
            },
          );
          try {
            return await worker.run(async (scope) => {
              // The paired binding has finished its separate native schema transaction.
              ensuredDatabases.add(db);
              return await scope.execute(command);
            }, assertCurrent);
          } finally {
            await worker.close();
          }
        },
        assertCurrent,
      );
    },
    true,
  );
}

export function listMemoryEntryOrigins(params: {
  agentId: string;
  sessionIds?: readonly string[];
  entryKeys?: readonly string[];
}): MemoryEntryOrigin[] {
  return readOriginRows(params, params);
}

function readOriginRows(
  params: Parameters<typeof listMemoryEntryOrigins>[0],
  options: Parameters<typeof withOpenClawAgentDatabaseAsync>[0],
): MemoryEntryOrigin[] {
  if (params.sessionIds?.length === 0 || params.entryKeys?.length === 0) {
    return [];
  }
  const result = withOpenClawAgentDatabaseReadOnly(({ db }) => {
    if (!ensuredDatabases.has(db) && !tableExists(db, "memory_entry_origins")) {
      return [];
    }
    return readMemoryEntryOriginsInDatabase(db, params);
  }, options);
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

export async function recordMemoryEntryOrigins(
  params: MemoryOriginRecord,
): Promise<MemoryEntryOrigin[]> {
  if (params.origins.length === 0) {
    return [];
  }
  const input = {
    agentId: params.agentId,
    entryKey: params.entryKey,
    origins: params.origins.map((origin) => ({
      entryKey: origin.entryKey,
      agentId: origin.agentId,
      sessionId: origin.sessionId,
      sessionKey: origin.sessionKey,
      originClass: origin.originClass,
      observedAt: origin.observedAt,
    })),
  };
  return executeOriginCommand(captureOriginDatabaseOptions(params.agentId), {
    type: "record",
    input,
  });
}

async function deleteMemoryEntryOrigins(
  params: MemoryOriginDeletion,
  options: OriginDatabaseOptions,
  assertOriginal: () => void,
): Promise<number> {
  if (params.entryKeys.length === 0 || params.sessionIds?.length === 0) {
    return 0;
  }
  assertOriginal();
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
  }, options);
  if (!existing.found || !existing.value) {
    return 0;
  }
  return executeOriginCommand(options, { type: "delete", input: params }, assertOriginal);
}

export async function reserveMemoryEntryOrigins(params: {
  agentIds: readonly string[];
  previousMemory: string;
  operations: readonly {
    candidateKey: string;
    action: "added" | "merged" | "superseded";
    priorEntries: readonly string[];
  }[];
}): Promise<() => Promise<void>> {
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
    return { operation: { ...operation, priorEntries: [...operation.priorEntries] }, parentKeys };
  });
  const affectedKeys = [...new Set(operationParents.flatMap(({ parentKeys }) => [...parentKeys]))];
  if (affectedKeys.length === 0) {
    return async () => {};
  }
  const owners = [...new Set(params.agentIds)].toSorted().map(captureOriginDatabaseOptions);
  const reservations: Array<{
    params: MemoryOriginDeletion;
    options: OriginDatabaseOptions;
    assertCurrent: () => void;
  }> = [];
  const rollback = async () => {
    for (const reservation of reservations.toReversed()) {
      await deleteMemoryEntryOrigins(
        reservation.params,
        reservation.options,
        reservation.assertCurrent,
      );
    }
  };
  try {
    for (const options of owners) {
      await runOpenClawAgentWriteAdmission(
        options,
        async (_identity, assertCurrent) => {
          const agentId = options.agentId;
          const origins = readOriginRows({ agentId, entryKeys: affectedKeys }, options);
          for (const { operation, parentKeys } of operationParents) {
            const selected = origins.filter((origin) => parentKeys.has(origin.entryKey));
            if (selected.length === 0) {
              continue;
            }
            const added = await executeOriginCommand(
              options,
              {
                type: "record",
                input: { agentId, origins: selected, entryKey: operation.candidateKey },
              },
              assertCurrent,
            );
            if (added.length > 0) {
              reservations.push({
                params: {
                  agentId,
                  entryKeys: [operation.candidateKey],
                  sessionIds: added.map((origin) => origin.sessionId),
                },
                options,
                assertCurrent,
              });
            }
          }
        },
        true,
      );
    }
  } catch (error) {
    await rollback();
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
  const owners = [...new Set(params.agentIds)].map(captureOriginDatabaseOptions);
  // Keep diary origins through backup rotation; callers hold the workspace lock.
  const diaries = await Promise.all(
    DREAMS_FILENAMES.map((name) =>
      readDreamsFile(path.join(params.workspaceDir, name), params.workspaceDir),
    ),
  );
  const diaryKeys = new Set(diaries.flatMap(extractPromotionKeys));
  for (const options of owners) {
    await runOpenClawAgentWriteAdmission(
      options,
      async (_identity, assertCurrent) => {
        const agentId = options.agentId;
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
          options,
        );
        await deleteMemoryEntryOrigins(
          {
            agentId,
            entryKeys: entryKeys.filter(
              (key) => !diaryKeys.has(key) && !(indexed.found && indexed.value.has(key)),
            ),
          },
          options,
          assertCurrent,
        );
      },
      true,
    );
  }
}
