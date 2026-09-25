import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MEMORY_CHUNKING_VERSION } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readMemoryDatabaseRevision } from "./memory/manager-db-kernel.js";
import { createManagerIndexFixture } from "./memory/manager-index.test-support.js";
import { MEMORY_INDEX_PROVENANCE_VERSION } from "./memory/manager-reindex-state.js";
import { createMemorySearchTool, testing } from "./tools.js";
const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./memory/index.js");
const { MemoryIndexManager } = await import("./memory/manager.js");
const versions = [
  { versionKey: "provenanceVersion", currentVersion: MEMORY_INDEX_PROVENANCE_VERSION },
  { versionKey: "chunkingVersion", currentVersion: MEMORY_CHUNKING_VERSION },
] as const;
describe("memory_search index versions", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  beforeEach(() => testing.resetMemorySearchToolCooldowns());
  async function seedIndex(
    storedVersions: Record<string, number | undefined>,
    provider = "openai",
  ) {
    const cfg = fixture.createConfig({
      provider,
      vectorEnabled: false,
      fallback: "none",
      batchEnabled: provider === "batch-test",
    });
    cfg.memory = { ...cfg.memory, search: { ...cfg.memory?.search, cache: { enabled: false } } };
    const manager = await fixture.getFreshManager(cfg);
    await manager.sync({ reason: "cli", force: true });
    await manager.close();
    await closeAllMemorySearchManagers();
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const row = db
      .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
      .get() as { value: string };
    db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
      JSON.stringify({ ...JSON.parse(row.value), ...storedVersions }),
    );
    return {
      cfg,
      db,
      before: readMemoryDatabaseRevision(db),
      embedded: fixture.provider.embedBatchCalls,
    };
  }

  it.each(
    versions.flatMap(({ versionKey, currentVersion }) =>
      [undefined, currentVersion - 1, currentVersion, currentVersion + 1].flatMap((storedVersion) =>
        (storedVersion === currentVersion + 1 ? [false, true] : [false]).map((mixed) => ({
          versionKey,
          currentVersion,
          storedVersion,
          mixed,
        })),
      ),
    ),
  )(
    "memory_search handles $versionKey=$storedVersion (mixed=$mixed) without unwanted rebuilds",
    async ({ versionKey, currentVersion, storedVersion, mixed }) => {
      const { cfg, db, before, embedded } = await seedIndex({
        [versionKey]: storedVersion,
        ...(mixed
          ? versionKey === "provenanceVersion"
            ? { chunkingVersion: MEMORY_CHUNKING_VERSION - 1 }
            : { provenanceVersion: MEMORY_INDEX_PROVENANCE_VERSION - 1 }
          : {}),
      });

      const tool = createMemorySearchTool({ config: cfg, agentId: "main" });
      if (!tool) {
        throw new Error("memory_search tool missing");
      }
      const responses = await Promise.all(
        ["first", "concurrent"].map((id) => tool.execute(id, { query: "alpha", corpus: "memory" })),
      );
      const result = responses[0]!;
      if (storedVersion !== undefined && storedVersion > currentVersion) {
        expect(result.details).toMatchObject({
          results: [],
          unavailable: true,
          warning: expect.stringContaining("newer OpenClaw"),
          action: expect.stringContaining("provider cost"),
        });
        expect(readMemoryDatabaseRevision(db)).toBe(before);
        expect(fixture.provider.embedBatchCalls).toBe(embedded);
        expect(fixture.provider.embedQueryCalls).toBe(0);
        return;
      }
      expect(result.details).toMatchObject({
        results: [
          expect.objectContaining({
            path: "memory/2026-01-12.md",
            citation: expect.stringContaining("memory/2026-01-12.md"),
          }),
        ],
      });
      expect(result.details).not.toHaveProperty("unavailable");
      const after = readMemoryDatabaseRevision(db);
      if (storedVersion === currentVersion) {
        expect(after).toBe(before);
        expect(fixture.provider.embedBatchCalls).toBe(embedded);
        expect(result.details).not.toHaveProperty("warning");
      } else {
        expect(after).toBeGreaterThan(before);
        expect(fixture.provider.embedBatchCalls).toBe(embedded + 1);
        for (const response of responses) {
          expect(response.details).toHaveProperty(
            "warning",
            expect.stringContaining("provider cost"),
          );
        }
      }
      const repeat = await tool.execute("provenance-current", { query: "alpha", corpus: "memory" });
      expect(readMemoryDatabaseRevision(db)).toBe(after);
      expect(repeat.details).not.toHaveProperty("warning");
      expect(fixture.provider.embedBatchCalls).toBe(
        embedded + (storedVersion === currentVersion ? 0 : 1),
      );
    },
  );
  it("keeps the rebuild cost warning when subsequent query embedding fails", async () => {
    const { cfg, embedded } = await seedIndex({ provenanceVersion: 0 });
    fixture.provider.beforeEmbedQuery = async () => {
      throw new Error("synthetic query failure");
    };
    const tool = createMemorySearchTool({ config: cfg, agentId: "main" })!;
    const result = await tool.execute("query-failure", { query: "alpha", corpus: "memory" });
    expect(result.details).toMatchObject({
      unavailable: true,
      error: expect.stringContaining("synthetic query failure"),
      warning: expect.stringContaining("provider cost"),
    });
    expect(fixture.provider.embedBatchCalls).toBe(embedded + 1);
  });

  it("discloses search rebuilding an older empty index after a file gains content", async () => {
    const file = path.join(fixture.paths.memory, "2026-01-12.md");
    await fs.writeFile(file, "");
    const { cfg, db, embedded } = await seedIndex({ provenanceVersion: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM memory_index_chunks").get()?.count).toBe(0);
    await fs.writeFile(file, "Alpha memory added after the old empty index.");
    const tool = createMemorySearchTool({ config: cfg, agentId: "main" })!;
    const result = await tool.execute("empty-index-upgrade", { query: "alpha", corpus: "memory" });
    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ path: "memory/2026-01-12.md" })],
      warning: expect.stringContaining("provider cost"),
    });
    expect(fixture.provider.embedBatchCalls).toBe(embedded + 1);
  });

  it("discloses a full retry handed to detached maintenance before embedding finishes", async () => {
    const cfg = fixture.createConfig({
      provider: "openai",
      fallback: "none",
      vectorEnabled: false,
    });
    cfg.memory = { ...cfg.memory, search: { ...cfg.memory?.search, cache: { enabled: false } } };
    const embeddings = await import("./memory/embeddings.js");
    const createProvider = embeddings.createEmbeddingProvider;
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
    const create = vi
      .spyOn(embeddings, "createEmbeddingProvider")
      .mockImplementation(async (...args) => {
        const result = await createProvider(...args);
        const provider = result.provider;
        if (!provider) {
          throw new Error("fixture provider missing");
        }
        return {
          ...result,
          provider: {
            ...provider,
            embedBatch: async (inputs) => {
              if (failSync) {
                throw Object.assign(new Error("HTTP 400: synthetic reindex failure"), {
                  status: 400,
                });
              }
              if (holdSync) {
                entered.resolve();
                await release.promise;
              }
              return await provider.embedBatch(inputs);
            },
          },
        };
      });
    try {
      const manager = await fixture.getFreshManager(cfg);
      await manager.sync({ reason: "cli", force: true });
      failSync = true;
      await expect(manager.sync({ reason: "cli", force: true })).rejects.toThrow("HTTP 400");
      failSync = false;
      holdSync = true;
      const embedded = fixture.provider.embedBatchCalls;
      const tool = createMemorySearchTool({ config: cfg, agentId: "main" })!;
      const result = await tool.execute("detached-rebuild", { query: "alpha", corpus: "memory" });
      expect(result.details).toMatchObject({
        results: [expect.objectContaining({ path: "memory/2026-01-12.md" })],
        warning: expect.stringContaining("provider cost"),
      });
      // The next search starts after the request notice but before the detached writer admits it.
      const queryEntered = createDeferred<void>();
      fixture.provider.beforeEmbedQuery = async () => {
        queryEntered.resolve();
        await entered.promise;
      };
      const concurrent = tool.execute("detached-admission", { query: "alpha", corpus: "memory" });
      await queryEntered.promise;
      acquire.resolve();
      const concurrentResult = await concurrent;
      expect(concurrentResult.details).toHaveProperty(
        "warning",
        expect.stringContaining("provider cost"),
      );
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
      create.mockRestore();
    }
  });

  it("keeps the rebuild cost warning when a search deadline expires during embedding", async () => {
    const { cfg } = await seedIndex({ provenanceVersion: 0 }, "batch-test");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.provider.providerRuntimeBatchGate = release.promise;
    fixture.provider.providerRuntimeBatchEntered = () => entered.resolve();
    const tool = createMemorySearchTool({ config: cfg, agentId: "main" })!;
    const execution = tool.execute("rebuild-deadline", { query: "alpha", corpus: "memory" });
    try {
      await entered.promise;
      const result = await execution;
      expect(result.details).toMatchObject({
        unavailable: true,
        warning: expect.stringContaining("provider cost"),
      });
      expect(result.details).toHaveProperty("error", expect.stringContaining("timed out"));
    } finally {
      release.resolve();
      fixture.provider.providerRuntimeBatchGate = null;
      await closeAllMemorySearchManagers();
    }
  });
});
import fs from "node:fs/promises";
import path from "node:path";
