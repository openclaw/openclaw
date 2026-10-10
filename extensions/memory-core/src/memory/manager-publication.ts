import { randomUUID } from "node:crypto";
import type { SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
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
    const operation = randomUUID();
    const { header, rows } = memoryPublicationHeader(replacement);
    await scope.execute({ type: "stage.start", input: { operation, header, rows } });
    for (const fragments of memoryPublicationBatches(replacement)) {
      await scope.execute({ type: "stage.append", input: { operation, fragments } });
    }
    const result = await retry(
      () => scope.execute({ type: "source.replace", input: { operation, state: state() } }),
      prepare,
    );
    assertPublished?.();
    // Thrown failures close through the host owner; another command could hide the write outcome.
    if (result === undefined) {
      await scope.execute({ type: "stage.discard", input: { operation } });
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
  const operation = randomUUID();
  await scope.execute({
    type: "cache.stage.start",
    input: { operation, header: mutation.header, rows: mutation.entries.length },
  });
  for (const fragments of memoryEmbeddingCacheBatches(mutation.entries)) {
    await scope.execute({ type: "stage.append", input: { operation, fragments } });
  }
  const current = await retry(
    () => scope.execute({ type: "cache.write", input: { operation, expectedRevision } }),
    prepare,
  );
  if (current === undefined) {
    await scope.execute({ type: "stage.discard", input: { operation } });
  }
  if (current === false) {
    // Publish generation invalidation before releasing this writer turn.
    invalidate();
  }
  return current;
}
