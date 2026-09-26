import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("source-wide embedding publication ownership", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());

  it("preserves shared cached vectors when preceding files release their references", async () => {
    for (const name of ["first", "second"]) {
      await fs.writeFile(
        path.join(fixture.paths.memory, `${name}.md`),
        "Shared alpha beta source.",
      );
    }
    const manager = await fixture.getFreshManager(
      fixture.createConfig({
        provider: "batch-wide-test",
        batchEnabled: true,
        cacheEnabled: true,
        vectorEnabled: false,
      }),
      "cli",
    );
    await manager.sync({ reason: "cli", force: true });
    fixture.provider.providerRuntimeBatchCalls = [];
    const sharedVectors: number[][] = [];
    // oxlint-disable-next-line typescript/unbound-method -- Invoked with the actual database owner.
    const replaceSource = MemoryIndexDatabase.prototype.replaceSource;
    vi.spyOn(MemoryIndexDatabase.prototype, "replaceSource").mockImplementation(function (
      this: MemoryIndexDatabase,
      ...args
    ) {
      if (["memory/first.md", "memory/second.md"].includes(args[0].entry.path)) {
        sharedVectors.push(args[0].embeddings[0]!);
      }
      return replaceSource.apply(this, args);
    });
    await manager.sync({ reason: "cli", force: true });

    expect(fixture.provider.providerRuntimeBatchCalls).toEqual([]);
    expect(sharedVectors).toHaveLength(2);
    expect(sharedVectors[1]).toBe(sharedVectors[0]);
    expect(sharedVectors[1]).toEqual([1, 1, 0, 0]);
    const db = Reflect.get(manager, "db") as DatabaseSync;
    expect(
      db
        .prepare(
          "SELECT path, embedding FROM memory_index_chunks WHERE path IN (?, ?) ORDER BY path",
        )
        .all("memory/first.md", "memory/second.md"),
    ).toEqual([
      { path: "memory/first.md", embedding: encodeMemoryEmbedding([1, 1, 0, 0]) },
      { path: "memory/second.md", embedding: encodeMemoryEmbedding([1, 1, 0, 0]) },
    ]);
    expect(
      db
        .prepare(
          "SELECT path FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ? ORDER BY path",
        )
        .all("shared"),
    ).toEqual([{ path: "memory/first.md" }, { path: "memory/second.md" }]);
  });

  it("keeps a failed source atomic after a preceding source publishes and retries safely", async () => {
    const first = path.join(fixture.paths.memory, "first.md");
    const second = path.join(fixture.paths.memory, "second.md");
    await fs.writeFile(first, "Original alpha source.");
    await fs.writeFile(second, "Original beta source.");
    const manager = await fixture.getFreshManager(
      fixture.createConfig({
        provider: "batch-wide-test",
        batchEnabled: true,
        cacheEnabled: true,
        vectorEnabled: false,
      }),
      "cli",
    );
    await manager.sync({ reason: "cli", force: true });
    const db = Reflect.get(manager, "db") as DatabaseSync;
    const readSource = (sourcePath: string) => ({
      source: db.prepare("SELECT hash FROM memory_index_sources WHERE path = ?").get(sourcePath),
      chunks: db
        .prepare("SELECT id, text, embedding FROM memory_index_chunks WHERE path = ? ORDER BY id")
        .all(sourcePath),
    });
    const secondBefore = readSource("memory/second.md");
    await fs.writeFile(first, "Updated alpha alpha source.");
    await fs.writeFile(second, "Updated beta beta source.");
    Reflect.set(manager, "dirty", true);
    db.exec(`
      CREATE TRIGGER fail_retention_source BEFORE INSERT ON memory_index_chunks
      WHEN NEW.path = 'memory/second.md'
      BEGIN SELECT RAISE(ABORT, 'injected retained-source publication failure'); END;
    `);
    try {
      await expect(manager.sync({ reason: "watch" })).rejects.toThrow(
        "injected retained-source publication failure",
      );
      expect(readSource("memory/first.md").chunks).toEqual([
        {
          id: expect.any(String),
          text: "Updated alpha alpha source.",
          embedding: encodeMemoryEmbedding([2, 0, 0, 0]),
        },
      ]);
      expect(readSource("memory/second.md")).toEqual(secondBefore);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      db.exec("DROP TRIGGER fail_retention_source");
    }
    await manager.sync({ reason: "watch" });
    expect(readSource("memory/second.md").chunks).toEqual([
      {
        id: expect.any(String),
        text: "Updated beta beta source.",
        embedding: encodeMemoryEmbedding([0, 2, 0, 0]),
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT path FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ? ORDER BY path",
        )
        .all("updated"),
    ).toEqual([{ path: "memory/first.md" }, { path: "memory/second.md" }]);
  });
});
