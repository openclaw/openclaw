import { setTimeout as delay } from "node:timers/promises";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  openOpenClawAgentSqliteWorkerStoreV2,
  type SqliteWorkerStore,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import { MemoryIndexRevisionConflictError } from "./manager-db-kernel.js";
import type {
  MemoryEmbeddingCacheMutation,
  MemoryPublicationOperations,
  MemoryPublicationResult,
  MemoryPublicationState,
} from "./manager-publication-task.js";
import {
  memoryEmbeddingCacheBatches,
  memoryEmbeddingCacheFitsInline,
  memoryPublicationBatches,
  memoryPublicationHeader,
  memoryPublicationInline,
} from "./manager-publication-transfer.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

type PublicationScope = Pick<SqliteWorkerStore<MemoryPublicationOperations>, "execute">;
type PublicationRetry = <T>(
  run: () => Promise<MemoryPublicationResult<T>>,
  prepare: () => Promise<boolean>,
) => Promise<T | undefined>;

export async function initializePublishedMemory(
  options: Parameters<typeof openOpenClawAgentSqliteWorkerStoreV2>[0],
  schema: MemoryPublicationOperations["schema.admit"]["input"] | undefined,
  assertCurrent: () => void,
) {
  const worker = await openOpenClawAgentSqliteWorkerStoreV2<MemoryPublicationOperations>(
    options,
    { version: 2, assertCurrent },
    {
      moduleUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication),
      input: { kind: "agent" },
    },
  );
  try {
    await worker.prepare();
    if (!schema) {
      return undefined;
    }
    return await retryMemoryPublication({
      run: () => worker.execute({ type: "schema.admit", input: schema }, assertCurrent),
      busyTimeoutMs: 5_000,
      prepare: async () => true,
    });
  } finally {
    await worker.close();
  }
}

export async function retryMemoryPublication<T>(params: {
  run: () => Promise<MemoryPublicationResult<T>>;
  prepare: () => Promise<boolean>;
  busyTimeoutMs: number;
}): Promise<Extract<MemoryPublicationResult<T>, { ok: true }> | undefined> {
  const deadline = performance.now() + params.busyTimeoutMs;
  while (await params.prepare()) {
    const result = await params.run();
    if (result.ok) {
      return result;
    }
    const code = result.error.errcode === undefined ? undefined : result.error.errcode & 0xff;
    if (result.entered || (code !== 5 && code !== 6) || performance.now() >= deadline) {
      throw Object.assign(
        result.error.name === "MemoryIndexRevisionConflictError"
          ? new MemoryIndexRevisionConflictError(result.error.message)
          : new Error(result.error.message),
        result.error,
        { entered: result.entered, committed: result.committed },
      );
    }
    await delay(Math.min(25, Math.max(0, deadline - performance.now())));
  }
  return undefined;
}

/** Small publications use one request; larger inputs retain their bounded transfer scope. */
export async function publishMemorySource(params: {
  replacement: MemorySourceIndexReplacement;
  state: () => MemoryPublicationState;
  execute: PublicationScope["execute"];
  run: <T>(operation: (scope: PublicationScope) => Promise<T>) => Promise<T>;
  retry: PublicationRetry;
  prepare: () => Promise<boolean>;
  assertPublished: (() => void) | undefined;
}) {
  const { replacement, state, execute, run, retry, prepare, assertPublished } = params;
  const inline = memoryPublicationInline(replacement);
  if (inline) {
    return retry(
      () => execute({ type: "source.replace.inline", input: { ...inline, state: state() } }),
      prepare,
    );
  }
  return run(async (scope) => {
    const header = memoryPublicationHeader(replacement);
    await scope.execute({ type: "stage.start", input: { header } });
    for (const fragments of memoryPublicationBatches(replacement)) {
      await scope.execute({ type: "stage.append", input: { fragments } });
    }
    const result = await retry(
      () => scope.execute({ type: "source.replace", input: { state: state() } }),
      prepare,
    );
    assertPublished?.();
    // Thrown failures close through the host owner; another command could hide the write outcome.
    if (result === undefined) {
      await scope.execute({ type: "stage.discard", input: undefined });
    }
    return result;
  });
}

/** The committing worker checks the captured revision before retaining vectors. */
export async function publishMemoryEmbeddingCache(params: {
  scope: PublicationScope;
  mutation: MemoryEmbeddingCacheMutation;
  prepareRevision: () => number | undefined;
  invalidate: () => void;
  retry: PublicationRetry;
}): Promise<boolean | undefined> {
  const { scope, mutation, prepareRevision, invalidate, retry } = params;
  const expectedRevision = prepareRevision();
  if (expectedRevision === undefined) {
    return undefined;
  }
  const prepare = async () => prepareRevision() !== undefined;
  if (mutation.kind === "clear") {
    try {
      return await retry(
        () =>
          scope.execute({
            type: "cache.clear",
            input: { identities: mutation.identities, expectedRevision },
          }),
        prepare,
      );
    } finally {
      // The vector-space conflict is already known, even if clearing loses its reply.
      invalidate();
    }
  }
  if (memoryEmbeddingCacheFitsInline(mutation.header, mutation.entries)) {
    const current = await retry(
      () =>
        scope.execute({
          type: "cache.write.inline",
          input: { header: mutation.header, entries: mutation.entries, expectedRevision },
        }),
      prepare,
    );
    if (current === false) {
      invalidate();
    }
    return current;
  }
  await scope.execute({
    type: "cache.stage.start",
    input: { header: mutation.header },
  });
  for (const fragments of memoryEmbeddingCacheBatches(mutation.entries)) {
    await scope.execute({ type: "stage.append", input: { fragments } });
  }
  const current = await retry(
    () => scope.execute({ type: "cache.write", input: { expectedRevision } }),
    prepare,
  );
  if (current === undefined) {
    await scope.execute({ type: "stage.discard", input: undefined });
  }
  if (current === false) {
    // Publish generation invalidation before releasing this writer turn.
    invalidate();
  }
  return current;
}
