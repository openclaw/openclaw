import { randomUUID } from "node:crypto";
import type { SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type {
  MemoryEmbeddingCacheMutation,
  MemoryPublicationOperations,
  MemoryPublicationResult,
} from "./manager-publication-task.js";
import {
  memoryEmbeddingCacheBatches,
  memoryEmbeddingCacheFitsInline,
} from "./manager-publication-transfer.js";

/** The caller retains its writer turn through revision preparation and invalidation. */
export async function publishMemoryEmbeddingCache(params: {
  scope: Pick<SqliteWorkerStore<MemoryPublicationOperations>, "execute">;
  mutation: MemoryEmbeddingCacheMutation;
  prepareRevision: () => number | undefined;
  invalidate: () => void;
  retry: <T>(
    run: () => Promise<MemoryPublicationResult<T>>,
    prepare: () => Promise<boolean>,
  ) => Promise<T | undefined>;
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
