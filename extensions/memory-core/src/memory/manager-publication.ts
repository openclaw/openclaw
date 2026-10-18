import { setTimeout as delay } from "node:timers/promises";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  openOpenClawAgentSqliteWorkerStoreV2,
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
  type OpenClawAgentDatabaseExecution,
  type SqliteWorkerStore,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import type { MemoryDatabaseAdmission } from "./manager-database-admission.js";
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
  memoryPublicationGroup,
  memoryPublicationHeader,
  memoryPublicationInline,
  releaseMemoryPublication,
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
    const admitted = schema
      ? await retryMemoryPublication({
          run: () => worker.execute({ type: "schema.admit", input: schema }, assertCurrent),
          busyTimeoutMs: 5_000,
          prepare: async () => true,
        })
      : undefined;
    return { worker, admitted };
  } catch (error) {
    await worker.close();
    throw error;
  }
}

export async function withPublishedMemoryExecution(
  options: Parameters<typeof openOpenClawAgentSqliteWorkerStoreV2>[0] | undefined,
  source: MemoryDatabaseAdmission["identity"],
  run: () => Promise<void>,
): Promise<void> {
  let execution: OpenClawAgentDatabaseExecution | undefined;
  if (options && supportsOpenClawAgentDatabaseExecution(options)) {
    if (!source) {
      throw new Error("Memory publication requires its live file owner");
    }
    // Retain across fallback preparation; a no-op generation never opens a native worker.
    execution = captureOpenClawAgentDatabaseExecution(options, {
      expectedIdentity: {
        kind: "file",
        physicalIdentity: source.identity,
        nativeLocation: source.filename,
        birthtime: source.birthtime,
      },
    });
  }
  const failures: unknown[] = [];
  for (const settle of [run, () => execution?.release()]) {
    try {
      await settle();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `${String(failures[0])}; Memory sync cleanup failed`, {
      cause: failures[0],
    });
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
export async function publishMemorySource(params: Parameters<typeof publishMemorySourceOnce>[0]) {
  // Preparation may splice the group, so capture its members before publishing.
  const printed = Array.isArray(params.replacement) ? [...params.replacement] : params.replacement;
  try {
    return await publishMemorySourceOnce(params);
  } finally {
    releaseMemoryPublication(printed);
  }
}

async function publishMemorySourceOnce(params: {
  replacement: MemorySourceIndexReplacement | MemorySourceIndexReplacement[];
  state: () => MemoryPublicationState;
  execute: PublicationScope["execute"];
  run: <T>(operation: (scope: PublicationScope) => Promise<T>) => Promise<T>;
  retry: PublicationRetry;
  prepare: () => Promise<boolean>;
  assertPublished: (() => void) | undefined;
}) {
  const { replacement, state, execute, run, retry, prepare, assertPublished } = params;
  if (Array.isArray(replacement)) {
    return retry(() => {
      // Preparation may exclude files edited while their embeddings were in flight.
      const sources = memoryPublicationGroup(replacement);
      if (!sources) {
        throw new Error("Memory publication group exceeds its bounded transfer");
      }
      return execute({ type: "source.replace.group", input: { sources, state: state() } });
    }, prepare);
  }
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

/** Cache entries are content-addressed; the worker excludes forgotten sessions. */
export async function publishMemoryEmbeddingCache(params: {
  scope: PublicationScope;
  mutation: MemoryEmbeddingCacheMutation;
  prepare: () => boolean;
  retry: PublicationRetry;
}): Promise<boolean | undefined> {
  const { scope, mutation, prepare, retry } = params;
  if (!prepare()) {
    return undefined;
  }
  const prepareRetry = async () => prepare();
  if (mutation.kind === "clear") {
    return await retry(
      () =>
        scope.execute({
          type: "cache.clear",
          input: { identities: mutation.identities },
        }),
      prepareRetry,
    );
  }
  if (memoryEmbeddingCacheFitsInline(mutation.header, mutation.entries)) {
    return await retry(
      () =>
        scope.execute({
          type: "cache.write.inline",
          input: { header: mutation.header, entries: mutation.entries },
        }),
      prepareRetry,
    );
  }
  await scope.execute({
    type: "cache.stage.start",
    input: { header: mutation.header },
  });
  for (const fragments of memoryEmbeddingCacheBatches(mutation.entries)) {
    await scope.execute({ type: "stage.append", input: { fragments } });
  }
  const current = await retry(
    () => scope.execute({ type: "cache.write", input: undefined }),
    prepareRetry,
  );
  if (current === undefined) {
    await scope.execute({ type: "stage.discard", input: undefined });
  }
  return current;
}
