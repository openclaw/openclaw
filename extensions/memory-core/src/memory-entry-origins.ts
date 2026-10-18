import path from "node:path";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { MemoryEntryOrigin } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { isFileMissingError } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { openOpenClawAgentSqliteWorkerStoreV2 } from "openclaw/plugin-sdk/sqlite-runtime";
import { DREAMS_FILENAMES, readDreamsFile } from "./dreaming-dreams-file.js";
import {
  captureMemoryAgentDatabaseOptions,
  captureMemoryAgentReadTarget,
} from "./memory-agent-database.js";
import {
  MEMORY_SESSION_TOMBSTONE_BATCH_SIZE,
  type MemoryEntryOriginOperations,
  type MemoryOriginDeletion,
  type MemoryOriginRecord,
} from "./memory-entry-origins-task.js";
import { captureMemoryMutationAuthority } from "./memory-mutation-authority.js";
import {
  assertMemoryShadowIdentity,
  readMemoryShadowIdentity,
} from "./memory/manager-shadow-task.js";
import { extractPromotionKeys } from "./short-term-promotion-memory-write.js";

export type { MemoryEntryOrigin };

// Lazy: the runtime-api graph must not statically reach the manager sidecar modules.
const loadMemoryCpuProcessEntrypoints = createLazyRuntimeModule(
  () => import("./memory/manager-cpu-entrypoints.js"),
);
const loadMemoryCpuWorkerRuntime = createLazyRuntimeModule(
  () => import("./memory/manager-cpu-worker-runtime.js"),
);
type OriginDatabaseOptions = ReturnType<typeof captureMemoryAgentDatabaseOptions>;

async function executeOriginCommand<Key extends "record" | "delete" | "reserve" | "prune">(
  options: OriginDatabaseOptions,
  command: { type: Key; input: MemoryEntryOriginOperations[Key]["input"] },
  assertOriginal?: () => void,
): Promise<MemoryEntryOriginOperations[Key]["output"] | undefined> {
  const { memoryCpuProcessEntrypoints } = await loadMemoryCpuProcessEntrypoints();
  const moduleUrl = resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.entryOrigins);
  assertOriginal?.();
  const worker = await openOpenClawAgentSqliteWorkerStoreV2<MemoryEntryOriginOperations>(
    options,
    { version: 2, assertCurrent: () => assertOriginal?.() },
    { moduleUrl, input: { kind: command.type === "record" ? "origin" : "origin-existing" } },
  );
  try {
    if (command.type === "record") {
      await worker.prepare();
      return await worker.run(
        (scope) => scope.execute(command),
        () => assertOriginal?.(),
      );
    }
    return (await worker.executeExisting(command, () => assertOriginal?.()))?.value;
  } finally {
    await worker.close();
  }
}

export async function listMemoryEntryOrigins(
  params: {
    agentId: string;
    sessionIds?: readonly string[];
    entryKeys?: readonly string[];
  },
  options?: OriginDatabaseOptions,
): Promise<MemoryEntryOrigin[]> {
  if (params.sessionIds?.length === 0 || params.entryKeys?.length === 0) {
    return [];
  }
  const target = captureMemoryAgentReadTarget(
    options ?? captureMemoryAgentDatabaseOptions(params.agentId),
  );
  const filters = {
    ...(params.sessionIds ? { sessionIds: [...params.sessionIds] } : {}),
    ...(params.entryKeys ? { entryKeys: [...params.entryKeys] } : {}),
  };
  const { runMemoryOriginRead } = await loadMemoryCpuWorkerRuntime();
  return (await runMemoryOriginRead({ ...target, ...filters, kind: "origin-rows" })).rows;
}

export async function findForgottenMemorySessionIds(params: {
  agentId: string;
  sessionIds: readonly string[];
}): Promise<Set<string>> {
  const forgotten = new Set<string>();
  if (params.sessionIds.length === 0) {
    return forgotten;
  }
  const target = captureMemoryAgentReadTarget(captureMemoryAgentDatabaseOptions(params.agentId));
  const sessionIds = [...params.sessionIds];
  const { runMemoryOriginRead } = await loadMemoryCpuWorkerRuntime();
  for (let start = 0; start < sessionIds.length; start += MEMORY_SESSION_TOMBSTONE_BATCH_SIZE) {
    const page = sessionIds.slice(start, start + MEMORY_SESSION_TOMBSTONE_BATCH_SIZE);
    const { indices } = await runMemoryOriginRead({
      ...target,
      sessionIds: page,
      kind: "session-tombstones",
    });
    for (const index of indices) {
      forgotten.add(page[index]!);
    }
  }
  return forgotten;
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
  return (
    (await executeOriginCommand(
      captureMemoryAgentDatabaseOptions(params.agentId),
      {
        type: "record",
        input,
      },
      captureMemoryMutationAuthority(),
    )) ?? []
  );
}

async function deleteMemoryEntryOrigins(
  params: MemoryOriginDeletion,
  options: OriginDatabaseOptions,
  assertOriginal: () => void,
): Promise<number> {
  if (params.entryKeys.length === 0 || params.sessionIds?.length === 0) {
    return 0;
  }
  return (
    (await executeOriginCommand(options, { type: "delete", input: params }, assertOriginal)) ?? 0
  );
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
  const owners = [...new Set(params.agentIds)].toSorted().map(captureMemoryAgentDatabaseOptions);
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
      let identity: ReturnType<typeof readMemoryShadowIdentity>;
      try {
        identity = readMemoryShadowIdentity(options.path);
      } catch (error) {
        if (isFileMissingError(error)) {
          continue;
        }
        throw error;
      }
      const assertCurrent = () => assertMemoryShadowIdentity(options.path, identity);
      const added =
        (await executeOriginCommand(
          options,
          {
            type: "reserve",
            input: {
              agentId: options.agentId,
              operations: operationParents.map(({ operation, parentKeys }) => ({
                entryKey: operation.candidateKey,
                parentKeys: [...parentKeys],
              })),
            },
          },
          assertCurrent,
        )) ?? [];
      for (const deletion of added) {
        reservations.push({ params: deletion, options, assertCurrent });
      }
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
  const owners = [...new Set(params.agentIds)].map(captureMemoryAgentDatabaseOptions);
  // Keep diary origins through backup rotation; callers hold the workspace lock.
  const diaries = await Promise.all(
    DREAMS_FILENAMES.map((name) =>
      readDreamsFile(path.join(params.workspaceDir, name), params.workspaceDir),
    ),
  );
  const diaryKeys = new Set(diaries.flatMap(extractPromotionKeys));
  for (const options of owners) {
    await executeOriginCommand(options, {
      type: "prune",
      input: {
        agentId: options.agentId,
        entryKeys: entryKeys.filter((key) => !diaryKeys.has(key)),
      },
    });
  }
}
