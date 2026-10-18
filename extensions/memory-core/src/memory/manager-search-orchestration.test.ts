// Memory Core tests cover manager search orchestration behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl, WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { recordMemoryEntryOrigins } from "../memory-entry-origins.js";
import { forgetMemoryEntries } from "../memory-forget.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import * as memoryCpuWorkerRuntime from "./manager-cpu-worker-runtime.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const { MemoryIndexManager } = await import("./manager.js");

describe("memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const {
    createConfig: createCfg,
    getFreshManager,
    getPersistentManager,
    seedSessionTranscript: seedMemoryIndexSessionTranscript,
  } = fixture;

  it("reuses published facts across searches and observes the next publication", async () => {
    providerFixture.forceNoProvider = true;
    const manager = await getPersistentManager(createCfg({ provider: "none", minScore: 0 }));
    const publishedPath = path.join(fixture.paths.memory, "published.md");
    await fs.writeFile(publishedPath, "orchid publication canary");
    await manager.sync({ reason: "test", force: true });
    const first = await manager.search("orchid", { minScore: 0 });
    expect(first).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "memory/published.md" })]),
    );
    const reads = vi.spyOn(memoryCpuWorkerRuntime, "runMemoryIndexRead");
    const keyword = vi.spyOn(memoryCpuWorkerRuntime, "runMemoryKeywordSearch");
    const state = vi.spyOn(memoryCpuWorkerRuntime, "runMemoryIndexState");
    try {
      expect(await manager.search("orchid", { minScore: 0 })).toEqual(first);
      expect(await manager.search("orchid", { minScore: 0 })).toEqual(first);
      expect(reads.mock.calls.filter(([, command]) => command.type === "index.facts")).toEqual([]);
      expect(state).not.toHaveBeenCalled();
      expect(keyword.mock.calls.map((call) => call[3])).toEqual([false, false]);

      await fs.writeFile(publishedPath, "iris publication canary");
      await manager.sync({ reason: "test" });
      expect(await manager.search("iris publication canary", { minScore: 0 })).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "memory/published.md" })]),
      );
    } finally {
      reads.mockRestore();
      keyword.mockRestore();
      state.mockRestore();
    }
  });

  it("invalidates keyword snapshots before changing the fallback provider", async () => {
    const manager = await getPersistentManager(
      createCfg({ fallback: "fallback-provider", minScore: 0 }),
    );
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as { provider: EmbeddingProvider };
    const fallbackGate = createDeferred<void>();
    const queryEntered = createDeferred<void>();
    const failQuery = createDeferred<void>();
    providerFixture.providerInitGate = fallbackGate.promise;
    const querySpy = vi.spyOn(fields.provider, "embed").mockImplementation(async () => {
      queryEntered.resolve();
      await failQuery.promise;
      throw new Error("embedding provider failed");
    });
    const snapshots: Array<Awaited<ReturnType<typeof manager.search>> | null> = [];
    const search = manager.search("zebra", {
      maxResults: 1,
      minScore: 0,
      onPartialResults: (results) => snapshots.push(results),
    });
    try {
      await queryEntered.promise;
      expect(snapshots).toEqual([[expect.objectContaining({ path: "memory/2026-01-12.md" })]]);
      failQuery.resolve();
      await vi.waitFor(() => {
        expect(providerFixture.providerCalls.at(-1)?.provider).toBe("fallback-provider");
      });
      expect(snapshots.at(-1)).toBeNull();
    } finally {
      failQuery.resolve();
      fallbackGate.resolve();
      await search.catch(() => undefined);
      querySpy.mockRestore();
      providerFixture.providerInitGate = null;
    }
  });

  it.each([6])(
    "rejects a query whose %i dimensions no longer match the index",
    async (dimensions) => {
      const manager = await getPersistentManager(createCfg({ provider: "openai" }));
      await manager.sync({ reason: "test", force: true });
      const fields = manager as unknown as { provider: EmbeddingProvider };
      const query = vi
        .spyOn(fields.provider, "embed")
        .mockResolvedValue(Array.from({ length: dimensions }, () => 1));

      await expect(manager.search("alpha")).rejects.toThrow(
        `query embedding has ${dimensions} dimensions, but the memory index expects 4`,
      );
      expect(query).toHaveBeenCalledTimes(1);

      query.mockRestore();
      expect(await manager.search("alpha")).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
      );
    },
  );

  it("keeps configured provider fallback available after query dimension drift", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "openai", fallback: "fallback-provider" }),
    );
    await manager.sync({ reason: "test", force: true });
    const fields = manager as unknown as { provider: EmbeddingProvider };
    vi.spyOn(fields.provider, "embed").mockResolvedValue([1, 0]);

    expect(await manager.search("alpha")).toEqual([]);
    expect(manager.status().provider).toBe("fallback-provider");
    await manager.sync({ reason: "test", force: true });
    expect(await manager.search("alpha")).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
    );
  });

  it("falls back to keyword results after bounded query embedding retries are exhausted with unset provider", async () => {
    const cfg = createCfg({});
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    let queryCalls = 0;
    (
      manager as unknown as {
        provider: EmbeddingProvider;
      }
    ).provider = {
      id: "mock",
      model: "mock-embed",
      embed: async () => {
        queryCalls += 1;
        throw new Error("TypeError: fetch failed | other side closed");
      },
      embedBatch: async (texts) => texts.map(() => [1, 0, 0, 0]),
      close: async () => {},
    };
    (
      manager as unknown as {
        waitForEmbeddingRetry: (delayMs: number, action: string) => Promise<void>;
      }
    ).waitForEmbeddingRetry = async () => {};

    const results = await manager.search("alpha");

    expect(queryCalls).toBe(3);
    expect(results.some((result) => result.path.endsWith("memory/2026-01-12.md"))).toBe(true);
  });

  it("keeps a healthy local provider active when the caller cancels search", async () => {
    const cfg = createCfg({});
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    const close = vi.fn(async () => {});
    let queryCalls = 0;
    const fields = manager as unknown as {
      provider: EmbeddingProvider;
      providerKey: string;
      providerLifecycle: { mode: "active"; providerId: string };
      computeProviderKey: () => string;
    };
    fields.provider = {
      id: "local",
      model: "mock-embed",
      embed: async () => {
        queryCalls += 1;
        return [1, 0, 0, 0];
      },
      embedBatch: async (texts) => texts.map(() => [1, 0, 0, 0]),
      close,
    };
    fields.providerLifecycle = { mode: "active", providerId: "local" };
    fields.providerKey = fields.computeProviderKey();
    await manager.sync({ reason: "test", force: true });

    const abortReason = new Error("memory search was cancelled");
    await expect(
      manager.search("alpha", { signal: AbortSignal.abort(abortReason) }),
    ).rejects.toMatchObject({ cause: abortReason });

    expect(manager.status()).toMatchObject({
      provider: "local",
      custom: {
        providerState: { mode: "active", providerId: "local" },
        providerUnavailableReason: undefined,
      },
    });
    await expect(manager.search("alpha")).resolves.not.toStrictEqual([]);
    expect(queryCalls).toBe(1);
    expect(close).not.toHaveBeenCalled();
  });

  it.each([false])(
    "rejects admitted keyword cancellation before embedding (lexicalOnly=%s)",
    async (lexicalOnly) => {
      const manager = await getPersistentManager(createCfg({ minScore: 0 }));
      await manager.sync({ reason: "test" });
      const caller = new AbortController();
      const abortReason = new Error("caller stopped keyword memory search");
      const runKeywordSearch = memoryCpuWorkerRuntime.runMemoryKeywordSearch;
      const keywordSpy = vi
        .spyOn(memoryCpuWorkerRuntime, "runMemoryKeywordSearch")
        .mockImplementationOnce((...args) => {
          const pending = runKeywordSearch(...args);
          caller.abort(abortReason);
          return pending;
        });
      const embeddingCalls = providerFixture.embedQueryCalls;

      try {
        await expect(manager.search("zebra", { signal: caller.signal, lexicalOnly })).rejects.toBe(
          abortReason,
        );
        expect(keywordSpy).toHaveBeenCalledTimes(1);
        expect(providerFixture.embedQueryCalls).toBe(embeddingCalls);
        const results = await manager.search("zebra", { lexicalOnly });
        expect(results.some((result) => result.path === "memory/2026-01-12.md")).toBe(true);
      } finally {
        keywordSpy.mockRestore();
      }
    },
  );

  it.each(["bootstrap", "vector"])(
    "rejects %s retrieval when shared worker admission is full and recovers after drain",
    async (mode) => {
      const cfg = createCfg({ vectorEnabled: false, minScore: 0 });
      const manager = await getPersistentManager(cfg);
      if (mode !== "bootstrap") {
        await manager.sync({ reason: "test" });
      }
      const capacityOwner = new WorkerTaskPool({
        workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.search),
        maxWorkers: 1,
        sharedCompute: true,
      });
      const preparation = createDeferred<never>();
      let accepted: Promise<PromiseSettledResult<unknown>[]> = Promise.resolve([]);
      const occupyAdmission = () => {
        accepted = Promise.allSettled(
          Array.from({ length: 128 }, () => capacityOwner.run(() => preparation.promise, {})),
        );
      };
      if (mode === "vector") {
        providerFixture.beforeEmbedQuery = async () => {
          occupyAdmission();
        };
      } else {
        occupyAdmission();
      }
      const vectorSearch = vi.spyOn(memoryCpuWorkerRuntime, "runMemoryVectorFallback");
      const query = mode === "vector" ? "alpha zebra" : "zebra";
      const embeddingCalls = providerFixture.embedQueryCalls;
      try {
        await expect(
          manager.search(query, { lexicalOnly: mode === "lexical" }),
        ).rejects.toMatchObject({
          name: "WorkerTaskError",
          code: "overloaded",
        });
        if (mode === "vector") {
          expect(providerFixture.embedQueryCalls).toBe(embeddingCalls + 1);
          expect(vectorSearch).toHaveBeenCalledOnce();
        } else {
          expect(providerFixture.embedQueryCalls).toBe(embeddingCalls);
        }
      } finally {
        providerFixture.beforeEmbedQuery = null;
        vectorSearch.mockRestore();
        const closed = capacityOwner.close();
        preparation.reject(new Error("release test capacity"));
        await closed;
        await accepted;
      }
      const results = await manager.search(query, { lexicalOnly: mode === "lexical" });
      expect(results.some((result) => result.path === "memory/2026-01-12.md")).toBe(true);
    },
  );

  it("rejects caller cancellation during hybrid fallback scanning", async () => {
    const manager = await getPersistentManager(
      createCfg({
        minScore: 0,
        vectorEnabled: false,
      }),
    );
    await manager.sync({ reason: "test" });

    const insertChunk = openOpenClawAgentDatabase({ agentId: "main" }).db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let index = 0; index < 4096; index += 1) {
      insertChunk.run(
        `cancel-scan-${index}`,
        `memory/cancel-scan-${index}.md`,
        "memory",
        1,
        1,
        `cancel-scan-hash-${index}`,
        "mock-embed",
        `fallback scan row ${index}`,
        encodeMemoryEmbedding([0, 1, 0, 0]),
        index,
      );
    }

    const caller = new AbortController();
    const abortReason = new Error("caller stopped hybrid memory search");
    const runVectorFallback = memoryCpuWorkerRuntime.runMemoryVectorFallback;
    const vectorSpy = vi
      .spyOn(memoryCpuWorkerRuntime, "runMemoryVectorFallback")
      .mockImplementationOnce((...args) => {
        const pending = runVectorFallback(...args);
        caller.abort(abortReason);
        return pending;
      });
    try {
      await expect(manager.search("alpha", { signal: caller.signal })).rejects.toBe(abortReason);
      expect(vectorSpy).toHaveBeenCalledTimes(1);
    } finally {
      vectorSpy.mockRestore();
    }

    const healthyResults = await manager.search("alpha");
    expect(healthyResults.some((result) => result.path === "memory/2026-01-12.md")).toBe(true);

    const unavailable = vi
      .spyOn(memoryCpuWorkerRuntime, "runMemoryVectorFallback")
      .mockRejectedValueOnce(new Error("vector store unavailable"));
    try {
      const degradedResults = await manager.search("alpha");
      expect(degradedResults.some((result) => result.path === "memory/2026-01-12.md")).toBe(true);
    } finally {
      unavailable.mockRestore();
    }
  });

  it("keeps zero-hit keyword fallback in one provider-backed worker request", async () => {
    const cfg = createCfg({
      minScore: 0.35,
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    const keywordSpy = vi.spyOn(memoryCpuWorkerRuntime, "runMemoryKeywordSearch");
    const partialResults = vi.fn();

    try {
      const results = await manager.search(
        "zebra project router gateway session transcript approval command owner workspace token budget retry queue",
        { maxResults: 5, onPartialResults: partialResults },
      );

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toContain("memory/2026-01-12.md");
      expect(results.length).toBeLessThanOrEqual(5);
      expect(partialResults).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
      );
      expect(keywordSpy).toHaveBeenCalledTimes(1);
    } finally {
      keywordSpy.mockRestore();
    }
  });

  it("keeps remember-only session transcripts out of ordinary manager searches", async () => {
    providerFixture.forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      rememberAcrossConversations: true,
      minScore: 0,
    });
    const manager = await getFreshManager(cfg);
    if (!manager.status().fts?.available) {
      return;
    }

    await seedMemoryIndexSessionTranscript({
      sessionId: "remember-only",
      messages: [
        {
          role: "assistant",
          timestamp: "2026-04-07T15:25:04.113Z",
          content: "Recall-only canary is NEBULA-47.",
        },
      ],
    });

    await manager.sync({ reason: "test", force: true });

    await expect(manager.search("Recall-only canary NEBULA-47", { minScore: 0 })).resolves.toEqual(
      [],
    );
    const trustedResults = await manager.search("Recall-only canary NEBULA-47", {
      minScore: 0,
      sources: ["sessions"],
    });
    expect(trustedResults[0]?.source).toBe("sessions");
  });

  it("searches the published index without flushing dirty sessions", async () => {
    providerFixture.forceNoProvider = true;
    const manager = await getPersistentManager(
      createCfg({
        provider: "none",
        sources: ["memory", "sessions"],
        sessionMemory: true,
        minScore: 0,
      }),
    );
    await manager.sync({ reason: "test", force: true });
    const content = "Quiet-period transcript canary is ORCHID-83.";
    await seedMemoryIndexSessionTranscript({
      sessionId: "search-sync",
      messages: [{ role: "assistant", timestamp: Date.now(), content }],
    });
    const servingFields = manager as unknown as {
      dirty: boolean;
      sessionsDirty: boolean;
      sessionsDirtyFiles: Set<string>;
      listSessionCorpusEntries: () => Promise<Array<{ sessionFile: string }>>;
    };
    const entries = await servingFields.listSessionCorpusEntries();
    expect(entries).toHaveLength(1);
    servingFields.dirty = false;
    servingFields.sessionsDirty = true;
    servingFields.sessionsDirtyFiles = new Set(entries.map((entry) => entry.sessionFile));
    const getSpy = vi.spyOn(MemoryIndexManager, "get");

    try {
      const publishedResults = await manager.search("zebra", { maxResults: 5, minScore: 0 });
      expect(publishedResults.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
      await expect(manager.search("ORCHID-83", { minScore: 0 })).resolves.toEqual([]);
      expect(getSpy.mock.calls.some(([params]) => params.purpose === "maintenance")).toBe(false);
      expect(servingFields.sessionsDirty).toBe(true);
      expect(servingFields.sessionsDirtyFiles).toEqual(
        new Set(entries.map((entry) => entry.sessionFile)),
      );
    } finally {
      getSpy.mockRestore();
    }

    await manager.sync({ reason: "test", force: true });
    expect(await manager.search("ORCHID-83", { minScore: 0 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "sessions", snippet: expect.stringContaining(content) }),
      ]),
    );
  });

  it("keeps search usable while maintenance syncs a full memory retry", async () => {
    providerFixture.forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      sources: ["memory", "sessions"],
      sessionMemory: true,
      minScore: 0,
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test", force: true });
    const content = "Current memory appears only after the dirty search sync.";
    await fs.writeFile(path.join(fixture.paths.memory, "search-sync.md"), content);
    const servingFields = manager as unknown as {
      dirty: boolean;
      memoryFullRetryDirty: boolean;
      awaitManagerIdle: () => Promise<void>;
    };
    servingFields.dirty = true;
    servingFields.memoryFullRetryDirty = true;

    const maintenanceReady = createDeferred<void>();
    const releaseMaintenance = createDeferred<void>();
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    let maintenanceClosed = false;
    let maintenanceFields:
      | {
          runInPlaceReindex: (params: unknown) => Promise<void>;
          syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
        }
      | undefined;
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await originalGet(params);
      if (params.purpose !== "maintenance" || !acquired) {
        return acquired;
      }
      const closeMaintenance = acquired.close.bind(acquired);
      vi.spyOn(acquired, "close").mockImplementation(async () => {
        await closeMaintenance();
        maintenanceClosed = true;
      });
      const fields = acquired as unknown as NonNullable<typeof maintenanceFields>;
      maintenanceFields = fields;
      vi.spyOn(fields, "runInPlaceReindex");
      const syncSource = fields.syncMemoryFiles.bind(acquired);
      vi.spyOn(fields, "syncMemoryFiles").mockImplementation(async (syncParams) => {
        const result = await syncSource(syncParams);
        maintenanceReady.resolve();
        await releaseMaintenance.promise;
        return result;
      });
      return acquired;
    });

    try {
      const firstSearch = manager.search("zebra", { maxResults: 5, minScore: 0 });
      await maintenanceReady.promise;
      expect(manager.status()).toMatchObject({ dirty: true });
      expect(maintenanceFields!.runInPlaceReindex).toHaveBeenCalledTimes(1);
      expect(maintenanceFields!.syncMemoryFiles).toHaveBeenCalledWith(
        expect.objectContaining({ needsFullReindex: true }),
      );

      const publishedResults = await firstSearch;
      expect(publishedResults.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
      await expect(
        manager.search("current dirty search sync", { maxResults: 5, minScore: 0 }),
      ).resolves.toEqual([]);

      releaseMaintenance.resolve();
      await servingFields.awaitManagerIdle();
      expect(manager.status().dirty).toBe(false);

      const refreshedResults = await manager.search("current dirty search sync", {
        maxResults: 5,
        minScore: 0,
      });
      expect(refreshedResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "memory", snippet: expect.stringContaining(content) }),
        ]),
      );
      expect(maintenanceClosed).toBe(true);
    } finally {
      releaseMaintenance.resolve();
      await servingFields.awaitManagerIdle();
      getSpy.mockRestore();
    }
  });

  it("rebuilds automatic maintenance from the revision after a concurrent memory purge", async () => {
    providerFixture.forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      sources: ["memory"],
      minScore: 0,
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test", force: true });
    const servingFields = manager as unknown as {
      dirty: boolean;
      memoryFullRetryDirty: boolean;
      awaitManagerIdle: () => Promise<void>;
    };

    const sessionId = "automatic-maintenance-purge";
    const memoryPath = path.join(fixture.paths.workspace, "MEMORY.md");
    await fs.writeFile(
      memoryPath,
      "# Memory\n<!-- openclaw-memory-promotion:private-entry -->\n- Private violet alpha fragment.\n",
    );
    await recordMemoryEntryOrigins({
      agentId: "main",
      origins: [
        {
          agentId: "main",
          sessionId,
          sessionKey: null,
          entryKey: "private-entry",
          originClass: "owner",
          observedAt: Date.now(),
        },
      ],
    });
    servingFields.dirty = true;
    servingFields.memoryFullRetryDirty = true;

    const shadowReady = createDeferred<void>();
    const releasePublish = createDeferred<void>();
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    let syncCalls = 0;
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await originalGet(params);
      if (params.purpose !== "maintenance" || !acquired) {
        return acquired;
      }
      const fields = acquired as unknown as {
        syncMemoryFiles: (params: unknown) => Promise<unknown>;
      };
      const syncMemoryFiles = fields.syncMemoryFiles.bind(acquired);
      vi.spyOn(fields, "syncMemoryFiles").mockImplementation(async (syncParams) => {
        const result = await syncMemoryFiles(syncParams);
        syncCalls += 1;
        if (syncCalls === 1) {
          shadowReady.resolve();
          await releasePublish.promise;
        }
        return result;
      });
      return acquired;
    });

    try {
      const search = manager.search("zebra", { maxResults: 5, minScore: 0 });
      await shadowReady.promise;
      await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: [sessionId] });
      releasePublish.resolve();

      await expect(search).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
      );
      await servingFields.awaitManagerIdle();
      expect(manager.status()).toMatchObject({ dirty: false, lastSyncError: undefined });
      expect(syncCalls).toBe(2);
      expect(await fs.readFile(memoryPath, "utf8")).not.toContain("Private violet");
      const database = Reflect.get(manager, "db") as DatabaseSync;
      expect(
        database
          .prepare("SELECT text FROM memory_index_chunks WHERE text LIKE '%Private violet%'")
          .all(),
      ).toEqual([]);
    } finally {
      releasePublish.resolve();
      await servingFields.awaitManagerIdle();
      getSpy.mockRestore();
    }
  });

  it("keeps transient CLI search off the serving manager write path", async () => {
    providerFixture.forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0,
    });
    const initialManager = await getFreshManager(cfg, "cli");
    await initialManager.sync({ reason: "test", force: true });
    await initialManager.close?.();
    await fs.writeFile(
      path.join(fixture.paths.memory, "cli-refresh.md"),
      "Content published after transient CLI maintenance.",
    );

    const manager = await getFreshManager(cfg, "cli", true);
    const servingFields = manager as unknown as {
      syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
    };
    const servingSync = vi.spyOn(servingFields, "syncMemoryFiles");
    const maintenanceReady = createDeferred<void>();
    const releaseMaintenance = createDeferred<void>();
    let closePromise: Promise<void> | undefined;
    let maintenanceClosed = false;
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await originalGet(params);
      if (params.purpose !== "maintenance" || !acquired) {
        return acquired;
      }
      const closeMaintenance = acquired.close.bind(acquired);
      vi.spyOn(acquired, "close").mockImplementation(async () => {
        await closeMaintenance();
        maintenanceClosed = true;
      });
      const fields = acquired as unknown as {
        syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
      };
      const syncMemoryFiles = fields.syncMemoryFiles.bind(acquired);
      vi.spyOn(fields, "syncMemoryFiles").mockImplementation(async (syncParams) => {
        const result = await syncMemoryFiles(syncParams);
        maintenanceReady.resolve();
        await releaseMaintenance.promise;
        return result;
      });
      return acquired;
    });

    try {
      const search = manager.search("zebra", {
        maxResults: 5,
        minScore: 0,
        sessionKey: "agent:main:cli:memory-search",
      });
      await vi.waitFor(() =>
        expect(getSpy).toHaveBeenCalledWith(expect.objectContaining({ purpose: "maintenance" })),
      );
      await maintenanceReady.promise;
      const results = await search;

      expect(results.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
      expect(servingSync).not.toHaveBeenCalled();
      if (typeof manager.close !== "function") {
        throw new Error("Expected CLI memory manager close support");
      }
      closePromise = manager.close();
      let closeSettled = false;
      void closePromise.then(() => {
        closeSettled = true;
      });
      await vi.waitFor(() => expect(closeSettled).toBe(true));
      expect(maintenanceClosed).toBe(false);
    } finally {
      releaseMaintenance.resolve();
      await closePromise;
      getSpy.mockRestore();
      await manager.close?.();
    }
  });

  it("does not let a no-op sync hide a later detached failure", async () => {
    const manager = await getPersistentManager(createCfg({ provider: "none", minScore: 0 }));
    await manager.sync({ reason: "baseline" });
    const maintenanceStarted = createDeferred<void>();
    const releaseMaintenance = createDeferred<void>();
    const maintenance = {
      adoptReindexRetryState: vi.fn(),
      sync: vi.fn(async () => {
        maintenanceStarted.resolve();
        await releaseMaintenance.promise;
        throw new Error("older maintenance failed");
      }),
      close: vi.fn(async () => {}),
    };
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockResolvedValue(maintenance as never);
    Reflect.set(manager, "dirty", true);
    const detachedSync = (
      manager as unknown as {
        syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
      }
    ).syncPublishedIndexInBackground({ reason: "search" });

    try {
      await maintenanceStarted.promise;
      expect(manager.status().dirty).toBe(false);
      await manager.sync({ reason: "interval" });
      releaseMaintenance.resolve();
      await expect(detachedSync).rejects.toThrow("older maintenance failed");

      expect(manager.status().dirty).toBe(true);
      expect(manager.status().lastSyncError).toContain("older maintenance failed");

      await manager.sync({ reason: "retry" });
      expect(manager.status().lastSyncError).toBeUndefined();
    } finally {
      releaseMaintenance.resolve();
      await detachedSync.catch(() => undefined);
      getSpy.mockRestore();
    }
  });

  it("restores a maintenance generation when a null fallback leaves it dirty", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
      minScore: 0,
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test", force: true });
    await fs.writeFile(
      path.join(fixture.paths.memory, "null-fallback.md"),
      "New content that requires a fallback embedding.",
    );
    Reflect.set(manager, "dirty", true);
    Reflect.set(manager, "memoryFullRetryDirty", true);
    providerFixture.providerNullResult = "fallback-provider";
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await originalGet(params);
      if (params.purpose !== "maintenance" || !acquired) {
        return acquired;
      }
      const fields = acquired as unknown as {
        ensureProviderInitialized: () => Promise<void>;
        provider: EmbeddingProvider | null;
      };
      await fields.ensureProviderInitialized();
      if (!fields.provider) {
        throw new Error("expected maintenance embedding provider");
      }
      fields.provider.embedBatch = async () => {
        throw providerFixture.createLocalWorkerExitError();
      };
      return acquired;
    });

    try {
      await expect(
        (
          manager as unknown as {
            syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
          }
        ).syncPublishedIndexInBackground({ reason: "search" }),
      ).resolves.toBeUndefined();

      expect(manager.status().dirty).toBe(true);
      expect(manager.status().lastSyncError).toContain("Local embedding worker exited");
      expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);
    } finally {
      providerFixture.providerNullResult = null;
      getSpy.mockRestore();
    }
  });
});
