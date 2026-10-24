import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { readTranscriptStatsBatchReadOnlySync } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import * as memoryStorage from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import * as cpuRuntime from "./manager-cpu-worker-runtime.js";
import type { MemoryIndexDatabase } from "./manager-database-context.js";
import * as fixtures from "./manager-index.test-support.js";

const managers = await import("./index.js");

describe("memory manager retained worker reads", () => {
  const fixture = fixtures.createManagerIndexFixture(managers);
  const { paths, provider, createConfig, getFreshManager } = fixture;
  const seedSession = (sessionId: string, content: string) =>
    fixture.seedSessionTranscript({
      sessionId,
      messages: [{ role: "user", timestamp: 1, content }],
    });
  const sessionConfig = () =>
    createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true });
  const memoryConfig = (overrides: Parameters<typeof fixture.createConfig>[0] = {}) =>
    createConfig({ provider: "none", sources: ["memory"], ...overrides });
  const writeMemory = (name: string, content: string) =>
    fs.writeFile(path.join(paths.memory, name), content);
  function observeSql() {
    const observed = observeHostDataSql();
    return { ...observed, [Symbol.dispose]: () => observed.restore() };
  }

  it("reopens invalidated source state without host data reads", async () => {
    await writeMemory("cold.md", "Alpha cold source.");
    const config = memoryConfig();
    const initial = await getFreshManager(config, "cli");
    await initial.sync({ reason: "baseline", force: true });
    // Published source changes advance the revision used by retained corpus facts.
    fixtures.memoryIndexFixtureWriter(initial).exec(`
      BEGIN IMMEDIATE;
      UPDATE memory_index_sources SET hash = '';
      UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
      COMMIT;
    `);
    await initial.close();
    using observed = observeSql();
    const manager = await getFreshManager(config, "cli");
    expect(Reflect.get(manager, "memorySourceProvenanceRepairPending")).toBe(true);
    expect(observed.queries.filter((sql) => /memory_index_sources/iu.test(sql))).toEqual([]);
  });

  it("keeps async status off host SQLite and warns once for legacy status", async () => {
    await writeMemory("vectors.md", "Alpha vector source.");
    const config = memoryConfig({ provider: "openai", vectorEnabled: true });
    using observed = observeSql();
    using emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const warn = memoryStorage.warnPluginSdkDeprecation;
    // Isolate the warning budget from fixture writers that also use legacy status.
    using scopedWarning = vi.spyOn(memoryStorage, "warnPluginSdkDeprecation");
    scopedWarning.mockImplementation((params) =>
      warn({ ...params, pluginId: "memory-status-compat" }),
    );
    const statusWarnings = () =>
      emitWarning.mock.calls.filter(([message]) =>
        String(message).includes("MemorySearchManager.status"),
      );
    const manager = await getFreshManager(config, "cli");
    expect(await manager.statusAsync()).toMatchObject({ files: 0, chunks: 0 });
    expect(await manager.probeVectorStoreAvailability()).toBe(true);
    await manager.sync({ reason: "cold-vectors", force: true });
    const indexed = await manager.statusAsync();
    expect(indexed.files).toBe(2);
    expect(indexed.chunks).toBeGreaterThan(0);
    expect((await manager.search("alpha", { minScore: 0 })).length).toBeGreaterThan(0);
    await manager.close();
    const reopened = await getFreshManager(config, "status");
    expect(await reopened.statusAsync()).toMatchObject({
      files: 2,
      chunks: indexed.chunks,
      sourceCounts: indexed.sourceCounts,
    });
    expect(observed.queries).toEqual([]);
    expect(statusWarnings()).toEqual([]);
    expect(reopened.status()).toMatchObject({ files: 2, chunks: indexed.chunks });
    reopened.status();
    await reopened.close();
    expect(() => reopened.status()).toThrow("Memory index manager is closed");
    expect(statusWarnings()).toEqual([
      [
        expect.stringContaining(
          "MemorySearchManager.status is deprecated; use MemorySearchManager.statusAsync instead.",
        ),
        { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
      ],
    ]);
    expect(String(statusWarnings()[0]?.[0])).toContain("Final compatibility day: 2026-12-31");
    expect(String(statusWarnings()[0]?.[0])).toContain("first January 2027 stable release");
  });

  it("keeps transcript statistics off the host during session catch-up", async () => {
    await seedSession("startup-stats", "Published startup statistics.");
    const manager = await getFreshManager(sessionConfig(), "cli");
    await manager.sync({ reason: "baseline", force: true });
    using observed = observeSql();
    await manager.sync({ reason: "cli" });
    expect(
      observed.queries.filter(
        (sql) =>
          (/transcript_events/i.test(sql) && /\b(?:count|sum)\s*\(/i.test(sql)) ||
          (/^select\b/i.test(sql) && /memory_index_sources/i.test(sql)),
      ),
    ).toEqual([]);
    expect(manager.status().dirty).toBe(false);
  });

  it("preserves grouped statistics, duplicate ordering, and missing stores across the worker", async () => {
    await seedSession("stats-parity", "Worker statistics parity.");
    const source = { agentId: "main", sessionId: "stats-parity" };
    const scopes = [
      source,
      ...Array.from({ length: 401 }, (_, index) => ({ ...source, sessionId: `absent-${index}` })),
      source,
      { agentId: "missing", sessionId: "missing" },
    ];
    const expected = readTranscriptStatsBatchReadOnlySync(scopes);
    using observed = observeSql();
    const actual = await cpuRuntime.readMemoryTranscriptStatsInWorker(scopes);
    expect(actual).toEqual(expected);
    expect(actual[0]?.eventCount).toBeGreaterThan(0);
    expect(actual.at(-2)).toEqual(actual[0]);
    expect(actual.at(-1)).toBeNull();
    expect(observed.queries).toEqual([]);
  });

  it("joins a startup statistics read before closing without scheduling late sync", async () => {
    await seedSession("startup-close", "Unindexed startup statistics.");
    const delivered = createDeferred<void>();
    const release = createDeferred<void>();
    const read = cpuRuntime.readMemoryTranscriptStatsInWorker;
    using reading = vi.spyOn(cpuRuntime, "readMemoryTranscriptStatsInWorker");
    reading.mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      delivered.resolve();
      await release.promise;
      return result;
    });
    const manager = await getFreshManager(sessionConfig());
    using sync = vi.spyOn(manager, "sync");
    const closed = vi.fn();
    let closing: Promise<void> | undefined;
    try {
      await delivered.promise;
      closing = manager.close().then(closed);
      await setImmediate();
      expect(closed).not.toHaveBeenCalled();
      release.resolve();
      await closing;
      expect(sync).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await closing;
    }
  });

  it.each(["ready", "rejected"] as const)(
    "waits for a %s cache read before requesting embeddings",
    async (outcome) => {
      const memoryPath = path.join(paths.memory, "2026-01-12.md");
      await fs.writeFile(memoryPath, "Published alpha cache-read source.");
      const manager = await getFreshManager(
        memoryConfig({ provider: "openai", cacheEnabled: true, vectorEnabled: false }),
        "cli",
      );
      await manager.sync({ reason: "baseline", force: true });
      const database = Reflect.get(manager, "publishedDatabase") as MemoryIndexDatabase;
      const publishedDb = database.db;
      const before = publishedDb.prepare("SELECT text FROM memory_index_chunks ORDER BY id").all();
      const replacement = "Replacement beta after the cache read.";
      await fs.writeFile(memoryPath, replacement);
      provider.embeddedBatchTexts = [];
      const delivered = createDeferred<void>();
      const release = createDeferred<void>();
      let readDelivered = false;
      const read = database.read.bind(database);
      using reading = vi.spyOn(database, "read");
      reading.mockImplementation(async (command, assertCurrent) => {
        const result = await read(command, assertCurrent);
        if (command.type === "cache.read") {
          readDelivered = true;
          delivered.resolve();
          await release.promise;
          if (outcome === "rejected") {
            throw new Error("controlled cache read rejection");
          }
        }
        return result;
      });
      const sync = manager.sync({ reason: "delayed-cache", force: true });
      void sync.catch(() => undefined);
      try {
        await Promise.race([delivered.promise, sync]);
        expect(readDelivered).toBe(true);
        expect(provider.embeddedBatchTexts).toEqual([]);
        expect(
          publishedDb.prepare("SELECT text FROM memory_index_chunks ORDER BY id").all(),
        ).toEqual(before);
        release.resolve();
        if (outcome === "ready") {
          await sync;
          expect(provider.embeddedBatchTexts).toEqual([replacement]);
        } else {
          await expect(sync).rejects.toThrow("controlled cache read rejection");
          expect(provider.embeddedBatchTexts).toEqual([]);
        }
        expect(
          openOpenClawAgentDatabase({ agentId: "main" })
            .db.prepare("SELECT text FROM memory_index_chunks ORDER BY id")
            .all(),
        ).toEqual(outcome === "ready" ? [{ text: replacement }] : before);
      } finally {
        release.resolve();
        await sync.catch(() => undefined);
      }
    },
  );
});
