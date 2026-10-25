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
          vectorEnabled: false,
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

      expect(fixture.provider.embeddedBatchTexts.toSorted()).toEqual([
        "cached text 0",
        "cached text 1",
        "cached text 2",
        "cached text 3",
      ]);
      expect(writer.prepare("SELECT count(*) AS n FROM memory_index_chunks").get()).toEqual({
        n: 12,
      });
      expect(writer.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get()).toEqual({
        n: 12,
      });
    },
  );

  it("bounds the canonical cache before every incremental transaction commits", async () => {
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
          input: { kind: "cache-capacity", publication: worker.input, maximum: 2 },
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
    for (let i = 0; i < 4; i += 1) {
      await fs.writeFile(path.join(fixture.paths.memory, `${i}.md`), `unique cache content ${i}`);
    }
    // Allow UPSERT-before-prune within a transaction, but reject overflow at
    // every commit so a later transaction cannot hide a published excess.
    harness.dirty = true;
    await memoryManager.sync({ reason: "cli" });

    expect(interceptedPaths.length).toBeGreaterThan(0);
    expect(interceptedPaths.every((filename) => filename === harness.db.location())).toBe(true);
    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get(),
    ).toEqual({
      count: 2,
    });
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM memory_index_sources").get()).toEqual({
      count: 4,
    });
  });
});
