import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";

const memoryIndex = await import("./index.js");

describe("source-wide embedding publication ownership", () => {
  const fixture = createManagerIndexFixture(memoryIndex);
  const paths = ["memory/first.md", "memory/second.md"] as const;
  const pathRows = paths.map((sourcePath) => ({ path: sourcePath }));
  const chunk = (text: string, embedding: number[]) => ({
    id: expect.any(String),
    text,
    embedding: encodeMemoryEmbedding(embedding),
  });
  const write = async (texts: [string, string]) => {
    for (const index of [0, 1] as const) {
      await fs.writeFile(path.join(fixture.paths.workspace, paths[index]), texts[index]);
    }
  };
  const open = (provider: string, model?: string) =>
    fixture.getFreshManager(fixture.createConfig({ provider, model, ...options }), "cli");
  const options = { batchEnabled: true, cacheEnabled: true, vectorEnabled: false };
  const fts = (db: DatabaseSync, query: string) =>
    db
      .prepare(
        "SELECT path FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ? ORDER BY path",
      )
      .all(query);

  it.each(["batch-test", "batch-wide-test"])(
    "preserves cached vectors across a multi-source %s publication",
    async (provider) => {
      await write(["Shared alpha beta source.", "Shared alpha beta source."]);
      const manager = await open(provider, "embeddinggemma");
      await manager.sync({ reason: "cli", force: true });
      expect(fixture.provider.providerRuntimeBatchCalls.flat()).toContain(
        "title: none | text: Shared alpha beta source.",
      );
      fixture.provider.providerRuntimeBatchCalls = [];
      await manager.sync({ reason: "cli", force: true });

      expect(fixture.provider.providerRuntimeBatchCalls).toEqual([]);
      const db = Reflect.get(manager, "db") as DatabaseSync;
      const cached = db
        .prepare(
          "SELECT path, embedding FROM memory_index_chunks WHERE path IN (?, ?) ORDER BY path",
        )
        .all(...paths);
      expect(cached).toEqual(
        pathRows.map((row) => ({ ...row, embedding: encodeMemoryEmbedding([1, 1, 0, 0]) })),
      );
      expect(fts(db, "shared")).toEqual(pathRows);
    },
  );

  it("rolls back a failed publication group and retries every source safely", async () => {
    await write(["Original alpha source.", "Original beta source."]);
    const manager = await open("batch-wide-test");
    await manager.sync({ reason: "cli", force: true });
    const db = Reflect.get(manager, "db") as DatabaseSync;
    const readSource = (sourcePath: string) => ({
      source: db.prepare("SELECT hash FROM memory_index_sources WHERE path = ?").get(sourcePath),
      chunks: db
        .prepare("SELECT id, text, embedding FROM memory_index_chunks WHERE path = ? ORDER BY id")
        .all(sourcePath),
    });
    const before = paths.map(readSource);
    await write(["Updated alpha alpha source.", "Updated beta beta source."]);
    Reflect.set(manager, "dirty", true);
    memoryIndexFixtureWriter(manager).exec(`
      CREATE TRIGGER fail_retention_source BEFORE INSERT ON memory_index_chunks
      WHEN NEW.path = 'memory/second.md'
      BEGIN SELECT RAISE(ABORT, 'injected retained-source publication failure'); END;
    `);
    try {
      await expect(manager.sync({ reason: "watch" })).rejects.toThrow(
        "injected retained-source publication failure",
      );
      expect(paths.map(readSource)).toEqual(before);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      memoryIndexFixtureWriter(manager).exec("DROP TRIGGER fail_retention_source");
    }
    await manager.sync({ reason: "watch" });
    expect(paths.map((sourcePath) => readSource(sourcePath).chunks)).toEqual([
      [chunk("Updated alpha alpha source.", [2, 0, 0, 0])],
      [chunk("Updated beta beta source.", [0, 2, 0, 0])],
    ]);
    expect(fts(db, "updated")).toEqual(pathRows);
  });
});
