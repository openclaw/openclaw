import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MEMORY_CHUNKING_VERSION } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryIndexDatabase } from "./memory/manager-database-context.js";
import { readMemoryDatabaseRevision } from "./memory/manager-db-kernel.js";
import { createManagerIndexFixture } from "./memory/manager-index.test-support.js";
import { MEMORY_INDEX_PROVENANCE_VERSION } from "./memory/manager-reindex-state.js";
import { testing } from "./tools.js";
import { createMemorySearchToolOrThrow } from "./tools.test-helpers.js";
const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./memory/index.js");
const { MemoryIndexManager } = await import("./memory/manager.js");
describe("memory_search index versions", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  const query = Object.freeze({ query: "alpha", corpus: "memory" });
  beforeEach(() => testing.resetMemorySearchToolCooldowns());
  function uncachedConfig(provider = "openai") {
    return fixture.createConfig({
      provider,
      vectorEnabled: false,
      fallback: "none",
      batchEnabled: provider === "batch-test",
      cacheEnabled: false,
    });
  }

  const indexHit = expect.objectContaining({ path: "memory/2026-01-12.md" });
  const providerCost = expect.stringContaining("provider cost");
  const toolFor = (config: Parameters<typeof fixture.getFreshManager>[0], oneShotCliRun = false) =>
    createMemorySearchToolOrThrow({ config, agentId: "main", oneShotCliRun });
  const search = async (
    config: Parameters<typeof toolFor>[0],
    oneShotCliRun = false,
    params: { query: string; corpus: "memory" } = query,
  ) => (await toolFor(config, oneShotCliRun).execute("search", params)).details;
  async function publishIndex(cfg: Parameters<typeof toolFor>[0]) {
    const manager = await fixture.getFreshManager(cfg);
    await manager.sync({ reason: "cli", force: true });
    return manager;
  }

  function setVersions(db: DatabaseSync, versions: Record<string, number | undefined>) {
    const key = "memory_index_meta_v1";
    const row = db.prepare("SELECT value FROM memory_index_meta WHERE key = ?").get(key);
    if (typeof row?.value !== "string") {
      throw new Error("fixture index metadata is missing");
    }
    db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = ?").run(
      JSON.stringify({ ...JSON.parse(row.value), ...versions }),
      key,
    );
  }

  async function seedIndex(
    storedVersions: Record<string, number | undefined>,
    cfg = uncachedConfig(),
  ) {
    const manager = await publishIndex(cfg);
    const dbPath = manager.status().dbPath;
    if (!dbPath) {
      throw new Error("memory search manager database path missing");
    }
    await manager.close();
    await closeAllMemorySearchManagers();
    const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db);
    setVersions(db, storedVersions);
    return {
      cfg,
      db,
      dbPath,
      before: readMemoryDatabaseRevision(db),
      embedded: fixture.provider.embedBatchCalls,
    };
  }

  it.each([
    { stored: { provenanceVersion: undefined }, newer: false },
    {
      stored: {
        chunkingVersion: MEMORY_CHUNKING_VERSION + 1,
        provenanceVersion: MEMORY_INDEX_PROVENANCE_VERSION - 1,
      },
      newer: true,
    },
  ])("handles index versions %j without unwanted rebuilds", async ({ stored, newer }) => {
    const { cfg, db, before, embedded } = await seedIndex(stored);
    const tool = toolFor(cfg);
    const responses = await Promise.all(
      ["first", "concurrent"].map((id) => tool.execute(id, query)),
    );
    const result = responses[0]!;
    if (newer) {
      expect(result.details).toMatchObject({
        results: [],
        unavailable: true,
        error: expect.stringContaining("newer OpenClaw"),
        action: providerCost,
      });
      expect(readMemoryDatabaseRevision(db)).toBe(before);
      expect(fixture.provider).toMatchObject({ embedBatchCalls: embedded, embedQueryCalls: 0 });
      return;
    }
    expect(result.details).toMatchObject({
      results: [indexHit],
    });
    expect(result.details).not.toHaveProperty("unavailable");
    const after = readMemoryDatabaseRevision(db);
    expect(after).toBeGreaterThan(before);
    expect(fixture.provider.embedBatchCalls).toBe(embedded + 1);
    for (const response of responses) {
      expect(response.details).toHaveProperty("warning", providerCost);
    }

    const repeat = await tool.execute("provenance-current", query);
    expect(readMemoryDatabaseRevision(db)).toBe(after);
    expect(repeat.details).not.toHaveProperty("warning");
    expect(fixture.provider.embedBatchCalls).toBe(embedded + 1);
  });
  it("keeps the rebuild cost warning when subsequent query embedding fails", async () => {
    const { cfg, embedded } = await seedIndex({ provenanceVersion: 0 });
    fixture.provider.beforeEmbedQuery = async () => {
      throw new Error("synthetic query failure");
    };
    expect(await search(cfg)).toMatchObject({
      unavailable: true,
      error: expect.stringContaining("synthetic query failure"),
      warning: providerCost,
    });
    expect(fixture.provider.embedBatchCalls).toBe(embedded + 1);
  });

  it("discloses search rebuilding an older empty index after a file gains content", async () => {
    const file = path.join(fixture.paths.memory, "2026-01-12.md");
    await fs.writeFile(file, "");
    const { cfg, db, embedded } = await seedIndex({ provenanceVersion: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM memory_index_chunks").get()?.count).toBe(0);
    await fs.writeFile(file, "Alpha memory added after the old empty index.");
    expect(await search(cfg)).toMatchObject({ results: [indexHit], warning: providerCost });
    expect(fixture.provider.embedBatchCalls).toBe(embedded + 1);
  });

  it("discloses a full retry handed to detached maintenance before embedding finishes", async () => {
    const cfg = uncachedConfig();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let failSync = false;
    let holdSync = false;
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const acquire = createDeferred<void>();
    const getManager = MemoryIndexManager.get.bind(MemoryIndexManager);
    const get = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      if (params.purpose === "maintenance") {
        await acquire.promise;
      }
      return await getManager(params);
    });
    fixture.provider.beforeEmbedBatch = async () => {
      if (failSync) {
        throw Object.assign(new Error("HTTP 400: synthetic reindex failure"), { status: 400 });
      }
      if (holdSync) {
        entered.resolve();
        await release.promise;
      }
    };
    try {
      const manager = await publishIndex(cfg);
      failSync = true;
      await expect(manager.sync({ reason: "cli", force: true })).rejects.toThrow("HTTP 400");
      failSync = false;
      clock.mockReturnValue(now + 30_000);
      holdSync = true;
      const embedded = fixture.provider.embedBatchCalls;
      const tool = toolFor(cfg);
      expect((await tool.execute("detached-rebuild", query)).details).toMatchObject({
        results: [indexHit],
        warning: providerCost,
      });
      // The next search starts after the request notice but before the detached writer admits it.
      const queryEntered = createDeferred<void>();
      fixture.provider.beforeEmbedQuery = async () => {
        queryEntered.resolve();
        await entered.promise;
      };
      const concurrent = tool.execute("detached-admission", query);
      await queryEntered.promise;
      acquire.resolve();
      const concurrentResult = await concurrent;
      expect(concurrentResult.details).toHaveProperty("warning", providerCost);
      expect(fixture.provider.embedBatchCalls).toBe(embedded);
      release.resolve();
      await manager.close();
      expect(fixture.provider.embedBatchCalls).toBe(embedded + 1);
    } finally {
      acquire.resolve();
      release.resolve();
      fixture.provider.beforeEmbedQuery = null;
      await closeAllMemorySearchManagers();
      get.mockRestore();
      clock.mockRestore();
      fixture.provider.beforeEmbedBatch = null;
    }
  });

  it("keeps the rebuild cost warning when a search deadline expires during embedding", async () => {
    const { cfg } = await seedIndex({ provenanceVersion: 0 }, uncachedConfig("batch-test"));
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.provider.providerRuntimeBatchGate = release.promise;
    fixture.provider.providerRuntimeBatchEntered = () => entered.resolve();
    vi.useFakeTimers();
    const execution = search(cfg);
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await execution).toMatchObject({
        unavailable: true,
        warning: providerCost,
        error: expect.stringContaining("timed out"),
      });
    } finally {
      release.resolve();
      fixture.provider.providerRuntimeBatchGate = null;
      vi.useRealTimers();
      await closeAllMemorySearchManagers();
    }
  });
  it("keeps newer-index advice after a real failed sync without rewriting the index", async () => {
    const cfg = uncachedConfig();
    let calls = 0;
    fixture.provider.beforeEmbedBatch = async () => {
      calls += 1;
    };
    try {
      const manager = await publishIndex(cfg);
      fixture.provider.embedBatchPermanentFailure = Object.assign(
        new Error("HTTP 400: synthetic embedding provider unavailable"),
        { status: 400 },
      );
      await expect(manager.sync({ reason: "cli", force: true })).rejects.toThrow("HTTP 400");
      const database = Reflect.get(manager, "publishedDatabase") as MemoryIndexDatabase;
      const meta = database.facts.meta;
      if (!meta) {
        throw new Error("Expected the published index metadata");
      }
      await database.writeMetadata({
        ...meta,
        provenanceVersion: MEMORY_INDEX_PROVENANCE_VERSION + 1,
      });
      const db = database.db;
      const before = readMemoryDatabaseRevision(db);
      const chunks = db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all();
      const priorCalls = calls;
      expect(await search(cfg)).toMatchObject({
        results: [],
        unavailable: true,
        error: expect.stringContaining("newer OpenClaw"),
        warning: expect.stringContaining("Previous memory sync failed: HTTP 400"),
        action: expect.stringContaining("upgrade OpenClaw or reindex explicitly"),
      });
      expect(manager.status().lastSyncError).toContain("HTTP 400");
      expect(readMemoryDatabaseRevision(db)).toBe(before);
      expect(db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all()).toEqual(chunks);
      expect(calls).toBe(priorCalls);
      expect(fixture.provider.embedQueryCalls).toBe(0);
    } finally {
      fixture.provider.embedBatchPermanentFailure = null;
    }
  });
  async function seedPriorChunkingVersionIndex(
    cfg: Parameters<typeof fixture.getFreshManager>[0],
  ): Promise<string> {
    const { dbPath } = await seedIndex({ chunkingVersion: MEMORY_CHUNKING_VERSION - 1 }, cfg);
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    return dbPath;
  }

  it.each(["keyword fallback", "missing FTS", "changed scope"] as const)(
    "handles an upgrade with %s",
    async (scenario) => {
      const cfg = fixture.createConfig({ minScore: 0 });
      const filePath = path.join(fixture.paths.memory, "upgrade.md");
      await fs.writeFile(filePath, "UpgradeKeywordFallback alpha note.");
      let indexedConfig = cfg;
      if (scenario === "changed scope") {
        const wikiPath = path.join(fixture.paths.root, "wiki");
        await fs.mkdir(wikiPath, { recursive: true });
        await fs.writeFile(path.join(wikiPath, "note.md"), "UpgradeScopeWiki alpha note.");
        indexedConfig = fixture.createConfig({ extraPaths: [wikiPath], minScore: 0 });
      }
      const dbPath = await seedPriorChunkingVersionIndex(indexedConfig);
      // A changed file prevents the embedding cache from satisfying the rebuild.
      await fs.writeFile(filePath, "UpgradeKeywordFallback changed after publication.");
      if (scenario === "missing FTS") {
        using db = new DatabaseSync(dbPath);
        db.exec("DROP TABLE IF EXISTS memory_index_chunks_fts");
        db.exec("CREATE VIEW memory_index_chunks_fts AS SELECT 1 AS text");
      }
      fixture.provider.embedBatchPermanentFailure = Object.assign(
        new Error("openai embeddings failed: 429 insufficient_quota"),
        { status: 429, code: "insufficient_quota" },
      );
      try {
        expect(
          await search(cfg, true, { ...query, query: "UpgradeKeywordFallback" }),
        ).toMatchObject(
          scenario === "keyword fallback"
            ? { results: [expect.objectContaining({ path: "memory/upgrade.md" })] }
            : {
                results: [],
                disabled: true,
                unavailable: true,
                error: expect.stringContaining("insufficient_quota"),
                warning: expect.stringContaining(
                  "Rebuilding may call the configured embedding provider",
                ),
              },
        );
      } finally {
        await closeAllMemorySearchManagers();
        closeOpenClawAgentDatabasesForTest();
      }
    },
  );
});
