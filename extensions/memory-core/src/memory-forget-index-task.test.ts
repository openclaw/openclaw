import { describe, expect, it } from "vitest";
import {
  forEachMemoryForgetChunkIdBatch,
  MEMORY_FORGET_CHUNK_ID_BATCH_SIZE,
} from "./memory-forget-index-task.js";

describe("memory forget chunk id batching", () => {
  it("keeps empty input empty", () => {
    expect(forEachMemoryForgetChunkIdBatch([], (batch) => batch.length)).toEqual([]);
  });

  it("preserves every id while splitting full and tail batches", () => {
    const ids = Array.from(
      { length: MEMORY_FORGET_CHUNK_ID_BATCH_SIZE * 2 + 3 },
      (_, index) => `chunk-${index}`,
    );
    const batches = forEachMemoryForgetChunkIdBatch(ids, (batch) => [...batch]);
    expect(batches.map((batch) => batch.length)).toEqual([
      MEMORY_FORGET_CHUNK_ID_BATCH_SIZE,
      MEMORY_FORGET_CHUNK_ID_BATCH_SIZE,
      3,
    ]);
    expect(batches.flat()).toEqual(ids);
  });
});
