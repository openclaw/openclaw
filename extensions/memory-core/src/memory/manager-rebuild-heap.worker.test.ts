import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import { MEMORY_INDEX_META_KEY } from "./manager-retrieval-read.js";

// Production read and SQLite store workers cap their heaps at 512 MiB; these hold less than a rebuild reuses.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class CappedWorker extends actual.Worker {
    constructor(filename: string | URL, options?: import("node:worker_threads").WorkerOptions) {
      const name = String(filename);
      const cap = name.includes("memory-search.worker")
        ? 32
        : name.includes("sqlite-store.worker")
          ? 96
          : undefined;
      super(
        filename,
        cap
          ? {
              ...options,
              resourceLimits: { ...options?.resourceLimits, maxOldGenerationSizeMb: cap },
            }
          : options,
      );
    }
  }
  return { ...actual, Worker: CappedWorker, default: { ...actual, Worker: CappedWorker } };
});

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

const DIMENSIONS = 4096;
const SECTIONS = 1000;

describe("memory rebuild vector reuse", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("rebuilds an index whose reused vectors exceed the worker heaps", async () => {
    await fs.rm(path.join(fixture.paths.memory, "2026-01-12.md"));
    await fs.writeFile(
      path.join(fixture.paths.memory, "archive.md"),
      Array.from(
        { length: SECTIONS },
        (_, i) => `## Record ${i}\n\n${`alpha archive entry ${i} `.repeat(90)}`,
      ).join("\n\n"),
    );
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ sources: ["memory"], cacheEnabled: false, vectorEnabled: false }),
      "cli",
    );
    await manager.sync({ reason: "cli", force: true });
    const writer = memoryIndexFixtureWriter(manager);
    const chunks = writer.prepare("SELECT id FROM memory_index_chunks").all() as Array<{
      id: string;
    }>;
    expect(chunks.length).toBeGreaterThanOrEqual(SECTIONS);
    // Widen every published vector so reusing them all exceeds the read worker heap.
    const widen = writer.prepare("UPDATE memory_index_chunks SET embedding = ? WHERE id = ?");
    for (const [index, chunk] of chunks.entries()) {
      widen.run(
        encodeMemoryEmbedding(
          Array.from({ length: DIMENSIONS }, (_, i) => ((index + i) % 97) / 97),
        ),
        chunk.id,
      );
    }
    const meta = writer
      .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
      .get(MEMORY_INDEX_META_KEY) as { value: string };
    writer
      .prepare("UPDATE memory_index_meta SET value = ? WHERE key = ?")
      .run(
        JSON.stringify({ ...JSON.parse(meta.value), vectorDims: DIMENSIONS }),
        MEMORY_INDEX_META_KEY,
      );
    const vectors = () => {
      const digest = createHash("sha256");
      let count = 0;
      for (const row of writer
        .prepare("SELECT hash, embedding FROM memory_index_chunks ORDER BY hash")
        .iterate() as Iterable<{ hash: string; embedding: Uint8Array }>) {
        digest.update(row.hash).update(row.embedding);
        count++;
      }
      return { count, digest: digest.digest("hex") };
    };
    const widened = vectors();
    fixture.provider.embeddedBatchTexts.length = 0;

    await manager.sync({ reason: "cli", force: true });

    expect(fixture.provider.embeddedBatchTexts).toEqual([]);
    expect(vectors()).toEqual(widened);
  });
});
