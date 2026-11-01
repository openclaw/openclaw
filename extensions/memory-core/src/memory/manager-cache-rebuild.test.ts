import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import { memoryPublicationFaultEntrypoint } from "./manager-publication-fault-entrypoint.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory rebuild cache reuse", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { cacheEnabled: true, vectorEnabled: true },
    { cacheEnabled: false, vectorEnabled: false },
  ])(
    "reuses shifted chunks during ordinary edits (cache=$cacheEnabled, vector=$vectorEnabled)",
    async ({ cacheEnabled, vectorEnabled }) => {
      const file = path.join(fixture.paths.memory, "2026-01-12.md");
      const original = Array.from({ length: 18 }, (_, i) =>
        `Alpha archive record ${i}: stable reference details.`.padEnd(900, "."),
      ).join("\n");
      await fs.writeFile(file, original);
      const manager = await fixture.getFreshManager(
        fixture.createConfig({ sources: ["memory"], cacheEnabled, vectorEnabled }),
        "cli",
      );
      await manager.sync({ reason: "cli", force: true });
      const writer = memoryIndexFixtureWriter(manager);
      const read = () =>
        writer
          .prepare(
            "SELECT id, hash, text, start_line, embedding FROM memory_index_chunks ORDER BY start_line",
          )
          .all();
      const before = read();
      expect(before.length).toBeGreaterThan(5);
      // Model a cache miss without deleting the canonical published vectors.
      writer.exec("DELETE FROM memory_embedding_cache");
      fixture.provider.embeddedBatchTexts.length = 0;
      await fs.writeFile(file, "Beta newly inserted header.\n" + original);
      Reflect.set(manager, "dirty", true);
      if (cacheEnabled) {
        writer.exec(`CREATE TRIGGER fail_edit_publication BEFORE INSERT ON memory_index_chunks
          BEGIN SELECT RAISE(ABORT, 'injected edit publication failure'); END;`);
        try {
          await expect(manager.sync({ reason: "watch" })).rejects.toThrow(
            "injected edit publication failure",
          );
          expect(read()).toEqual(before);
          expect(writer.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get()).toEqual({
            n: 1,
          });
        } finally {
          writer.exec("DROP TRIGGER fail_edit_publication");
        }
      }
      // Retry keeps the failed run's new vector; only the initial cache miss embeds it.
      await manager.sync({ reason: "watch" });
      const after = read();
      const unchanged = after.filter((row) => before.some((old) => old.hash === row.hash));
      expect(unchanged.length).toBeGreaterThan(5);
      expect(
        unchanged.every((row) =>
          before.some(
            (old) =>
              old.hash === row.hash && old.id !== row.id && old.start_line !== row.start_line,
          ),
        ),
      ).toBe(true);
      expect(fixture.provider.embeddedBatchTexts).toEqual([
        `Beta newly inserted header.\n${original.split("\n")[0]}`,
      ]);
      for (const row of unchanged) {
        expect(row.embedding).toEqual(before.find((old) => old.hash === row.hash)?.embedding);
      }
      const results = await manager.search("Beta newly inserted header", { minScore: 0 });
      expect(
        results.some((row) => row.path === "memory/2026-01-12.md" && row.snippet.includes("Beta")),
      ).toBe(true);
      if (!cacheEnabled) {
        expect(writer.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get()).toEqual({
          n: 0,
        });
      }
    },
  );

  it.each([
    { emptyIndex: false, failPublication: false },
    { emptyIndex: true, failPublication: false },
    { emptyIndex: false, failPublication: true },
  ])(
    "embeds only initial misses and settles capacity (empty=$emptyIndex, failure=$failPublication)",
    async ({ emptyIndex, failPublication }) => {
      await fs.rm(path.join(fixture.paths.memory, "2026-01-12.md"));
      const manager = await fixture.getFreshManager(
        fixture.createConfig({
          sources: ["memory"],
          cacheEnabled: true,
          vectorEnabled: true,
        }),
      );
      (manager as unknown as { cache: { maxEntries?: number } }).cache.maxEntries = 12;
      for (let i = 0; i < 12; i += 1) {
        await fs.writeFile(
          path.join(fixture.paths.memory, `${String(i).padStart(2, "0")}.md`),
          `cached text ${i}`,
        );
      }
      await manager.sync({ reason: "cli", force: true });
      const writer = memoryIndexFixtureWriter(manager);
      writer.exec(`DELETE FROM memory_embedding_cache WHERE hash IN (
        SELECT hash FROM memory_index_chunks WHERE path < 'memory/04.md'
      ); UPDATE memory_embedding_cache SET updated_at = 1;`);
      const insert = writer.prepare(`INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
        SELECT provider, model, provider_key, ?, ?, 4, ? FROM memory_embedding_cache LIMIT 1`);
      for (let i = 0; i < 4; i += 1) {
        insert.run(`superseded-${i}`, encodeMemoryEmbedding([0, 0, 0, 0]), Date.now() + i);
      }
      expect(writer.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get()).toEqual({
        n: 12,
      });
      if (emptyIndex) {
        writer.exec("DELETE FROM memory_index_chunks; DELETE FROM memory_index_sources;");
      }
      fixture.provider.embeddedBatchTexts.length = 0;
      if (failPublication) {
        vi.spyOn(MemoryIndexDatabase.prototype, "writeMetadata").mockRejectedValueOnce(
          new Error("failed shadow metadata"),
        );
      }

      const rebuild = manager.sync({ reason: "cli", force: true });
      if (failPublication) {
        await expect(rebuild).rejects.toThrow("failed shadow metadata");
      } else {
        await rebuild;
      }

      expect(fixture.provider.embeddedBatchTexts.toSorted()).toEqual(
        emptyIndex ? ["cached text 0", "cached text 1", "cached text 2", "cached text 3"] : [],
      );
      expect(writer.prepare("SELECT count(*) AS n FROM memory_index_chunks").get()).toEqual({
        n: 12,
      });
      expect(writer.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get()).toEqual({
        n: 12,
      });
      if (!emptyIndex && !failPublication) {
        await manager.close();
        const changedModel = await fixture.getFreshManager(
          fixture.createConfig({
            sources: ["memory"],
            cacheEnabled: true,
            vectorEnabled: true,
            model: "different-embedding-model",
          }),
        );
        fixture.provider.embeddedBatchTexts.length = 0;
        await changedModel.sync({ reason: "cli", force: true });
        expect(fixture.provider.embeddedBatchTexts.toSorted()).toEqual(
          Array.from({ length: 12 }, (_, i) => `cached text ${i}`).toSorted(),
        );
      }
    },
  );

  it.each(["incremental", "full"] as const)("bounds every %s cache transaction", async (mode) => {
    await fs.rm(path.join(fixture.paths.memory, "2026-01-12.md"));
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
    const interceptedPaths: Array<string | undefined> = [];
    // Install before manager startup can retain its canonical publication client.
    vi.spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2").mockImplementation(
      async (...args) => {
        const [options, source, worker] = args;
        if (
          options.agentId !== "main" ||
          options.path !== databasePath ||
          worker.moduleUrl.href !==
            resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication).href
        ) {
          return await open(...args);
        }
        const client = await open(options, source, {
          ...worker,
          moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
          input: {
            kind: "cache-capacity",
            publication: worker.input,
            maximum: mode === "full" ? 4 : 2,
          },
        });
        interceptedPaths.push(options.path);
        return client;
      },
    );
    const memoryManager = await fixture.getFreshManager(
      fixture.createConfig({ sources: ["memory"], cacheEnabled: true, vectorEnabled: false }),
    );
    const harness = memoryManager as unknown as {
      cache: { maxEntries?: number };
      dirty: boolean;
      db: DatabaseSync;
    };
    harness.cache.maxEntries = 2;
    await memoryManager.sync({ reason: "cli", force: true });
    const files = mode === "full" ? 5 : 4;
    for (let i = 0; i < files; i += 1) {
      await fs.writeFile(path.join(fixture.paths.memory, `${i}.md`), `unique cache content ${i}`);
    }
    // Full rebuilds may use twice the cap; every commit must stay within its
    // budget, and completion restores the normal cap.
    harness.dirty = true;
    await memoryManager.sync({ reason: "cli", force: mode === "full" });

    expect(interceptedPaths.length).toBeGreaterThan(0);
    expect(interceptedPaths.every((filename) => filename === harness.db.location())).toBe(true);
    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get(),
    ).toEqual({
      count: 2,
    });
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM memory_index_sources").get()).toEqual({
      count: files,
    });
  });
});
