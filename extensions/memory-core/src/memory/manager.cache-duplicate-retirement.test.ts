import fs from "node:fs/promises";
import path from "node:path";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory embedding cache duplicate retirement", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());

  const file = () => path.join(fixture.paths.memory, "2026-01-12.md");
  const paragraphs = Array.from({ length: 6 }, (_, i) =>
    `Alpha archive record ${i}: stable reference details.`.padEnd(900, "."),
  ).join("\n");

  async function indexedManager(cacheEnabled = true) {
    await fs.writeFile(file(), paragraphs);
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ sources: ["memory"], cacheEnabled, vectorEnabled: true }),
      "cli",
    );
    await manager.sync({ reason: "cli", force: true });
    const writer = memoryIndexFixtureWriter(manager);
    const cacheRows = () =>
      writer.prepare("SELECT hash FROM memory_embedding_cache ORDER BY hash").all();
    const chunkHashes = () =>
      writer.prepare("SELECT DISTINCT hash FROM memory_index_chunks ORDER BY hash").all();
    return { manager, writer, cacheRows, chunkHashes };
  }

  const edit = async (manager: object, text: string) => {
    await fs.writeFile(file(), `${text}\n${paragraphs}`);
    Reflect.set(manager, "dirty", true);
  };

  it("retires the vectors a full rebuild and an ordinary edit publish", async () => {
    const { manager, writer, cacheRows, chunkHashes } = await indexedManager();
    expect(chunkHashes().length).toBeGreaterThan(3);
    expect(cacheRows()).toEqual([]);

    fixture.provider.embeddedBatchTexts.length = 0;
    await edit(manager, "Beta newly inserted header.");
    await manager.sync({ reason: "watch" });
    expect(fixture.provider.embeddedBatchTexts).toHaveLength(1);
    expect(cacheRows()).toEqual([]);
    const results = await manager.search("Beta newly inserted header", { minScore: 0 });
    expect(results.some((row) => row.snippet.includes("Beta"))).toBe(true);
    expect(writer.prepare("SELECT count(*) AS n FROM memory_index_chunks").get()).toEqual({
      n: chunkHashes().length,
    });
  });

  it("keeps a failed edit's vectors so the retry reuses them", async () => {
    const { manager, writer, cacheRows } = await indexedManager();
    fixture.provider.embeddedBatchTexts.length = 0;
    await edit(manager, "Gamma header from a failed run.");
    writer.exec(`CREATE TRIGGER fail_edit_publication BEFORE INSERT ON memory_index_chunks
      BEGIN SELECT RAISE(ABORT, 'injected edit publication failure'); END;`);
    try {
      await expect(manager.sync({ reason: "watch" })).rejects.toThrow(
        "injected edit publication failure",
      );
    } finally {
      writer.exec("DROP TRIGGER fail_edit_publication");
    }
    const failedRunRows = cacheRows();
    expect(failedRunRows).toHaveLength(1);

    await manager.sync({ reason: "watch" });
    // The retry is served by the failed run's row, which then duplicates its publication.
    expect(fixture.provider.embeddedBatchTexts).toHaveLength(1);
    expect(cacheRows()).toEqual([]);
  });

  it("retires a skipped sync's rows after the next clean sync", async () => {
    const { manager, cacheRows } = await indexedManager();
    // A watcher event during indexing leaves the sync dirty, so it retires nothing.
    fixture.provider.beforeEmbedBatch = async () => {
      Reflect.set(manager, "dirty", true);
    };
    await edit(manager, "Iota header while another edit arrives.");
    await manager.sync({ reason: "watch" });
    fixture.provider.beforeEmbedBatch = null;
    expect(Reflect.get(manager, "dirty")).toBe(true);
    expect(cacheRows()).toHaveLength(1);

    await manager.sync({ reason: "watch" });
    expect(Reflect.get(manager, "dirty")).toBe(false);
    expect(cacheRows()).toEqual([]);
  });

  it("keeps a failed edit's vectors even when another file publishes the same text", async () => {
    const copy = `Theta copied header.\n${paragraphs}`;
    await fs.writeFile(path.join(fixture.paths.memory, "copy.md"), copy);
    const { manager, writer, cacheRows } = await indexedManager();
    expect(cacheRows()).toEqual([]);
    fixture.provider.embeddedBatchTexts.length = 0;
    // Read-through is scoped to the edited file, so the copied chunk is embedded again.
    await edit(manager, "Theta copied header.");
    writer.exec(`CREATE TRIGGER fail_edit_publication BEFORE INSERT ON memory_index_chunks
      BEGIN SELECT RAISE(ABORT, 'injected edit publication failure'); END;`);
    try {
      await expect(manager.sync({ reason: "watch" })).rejects.toThrow(
        "injected edit publication failure",
      );
    } finally {
      writer.exec("DROP TRIGGER fail_edit_publication");
    }
    expect(cacheRows()).toHaveLength(1);
    await manager.sync({ reason: "watch" });
    expect(fixture.provider.embeddedBatchTexts).toHaveLength(1);
  });

  it("keeps cached vectors that differ from the published chunk", async () => {
    const { manager, writer, cacheRows } = await indexedManager();
    // Cached bytes that differ from the published vector, as from a provider that is not
    // bit-deterministic or another process writing the same hash.
    const differing = Buffer.from(encodeMemoryEmbedding([9, 9, 9, 9])).toString("hex");
    writer.exec(`CREATE TRIGGER differing_cache_vector AFTER INSERT ON memory_embedding_cache
      BEGIN UPDATE memory_embedding_cache SET embedding = X'${differing}'
        WHERE rowid = NEW.rowid; END;`);
    try {
      await edit(manager, "Delta header with a nondeterministic vector.");
      await manager.sync({ reason: "watch" });
    } finally {
      writer.exec("DROP TRIGGER differing_cache_vector");
    }
    expect(cacheRows()).toHaveLength(1);
  });

  it("logs a cleanup failure without failing publication or scheduling a retry", async () => {
    const { manager, cacheRows } = await indexedManager();
    vi.spyOn(MemoryIndexDatabase.prototype, "retireEmbeddingCache").mockRejectedValue(
      new Error("injected cleanup failure"),
    );
    await edit(manager, "Epsilon header survives a cleanup failure.");
    await manager.sync({ reason: "watch" });
    expect(cacheRows()).toHaveLength(1);
    expect(Reflect.get(manager, "dirty")).toBe(false);
    expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(false);
    const results = await manager.search("Epsilon header", { minScore: 0 });
    expect(results.some((row) => row.snippet.includes("Epsilon"))).toBe(true);

    await manager.sync({ reason: "cli", force: true });
    expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(false);
  });

  it("retires existing duplicates only after a full rebuild publishes", async () => {
    const { manager, writer, cacheRows, chunkHashes } = await indexedManager();
    // Rows an older build kept: duplicates of every published chunk, plus one unpublished.
    writer.exec(`INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
      SELECT json_extract(meta.value, '$.provider'), chunk.model,
        json_extract(meta.value, '$.providerKey'), chunk.hash, chunk.embedding,
        length(chunk.embedding) / 8, 1
      FROM memory_index_chunks AS chunk, memory_index_meta AS meta
      WHERE meta.key = 'memory_index_meta_v1'`);
    const existing = cacheRows();
    expect(existing.length).toBeGreaterThan(3);
    writer.exec(`INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
      SELECT provider, model, provider_key, 'unpublished', embedding, dims, 1
      FROM memory_embedding_cache LIMIT 1`);

    // Ordinary syncs leave rows they did not write.
    await edit(manager, "Eta header on an ordinary sync.");
    await manager.sync({ reason: "watch" });
    expect(cacheRows()).toHaveLength(existing.length + 1);

    fixture.provider.embeddedBatchTexts.length = 0;
    await manager.sync({ reason: "cli", force: true });
    expect(fixture.provider.embeddedBatchTexts).toEqual([]);
    // The edit's replaced first chunk and the unpublished row stay; every duplicate goes.
    const published = new Set(chunkHashes().map((row) => row.hash));
    const remaining = cacheRows();
    expect(remaining).toHaveLength(2);
    expect(remaining).toContainEqual({ hash: "unpublished" });
    expect(remaining.every((row) => !published.has(row.hash))).toBe(true);
  });

  it("leaves a disabled cache alone", async () => {
    const spy = vi.spyOn(MemoryIndexDatabase.prototype, "retireEmbeddingCache");
    const { manager } = await indexedManager(false);
    await edit(manager, "Zeta header without a cache.");
    await manager.sync({ reason: "watch" });
    expect(spy).not.toHaveBeenCalled();
  });
});
