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
import {
  createManagerIndexFixture,
  holdMemoryTestOperation as hold,
} from "./manager-index.test-support.js";

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
  type Manager = Awaited<ReturnType<typeof getPersistentManager>>;
  type MaintenanceFields = {
    runInPlaceReindex: (params: unknown) => Promise<void>;
    syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
  };
  type ServingFields = {
    dirty: boolean;
    memoryFullRetryDirty: boolean;
    awaitManagerIdle: () => Promise<void>;
    syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
  };
  const serving = (manager: Manager) => manager as unknown as ServingFields;
  const provider = (manager: Manager) =>
    (manager as unknown as { provider: EmbeddingProvider }).provider;
  function markDirty(manager: Manager) {
    Object.assign(serving(manager), { dirty: true, memoryFullRetryDirty: true });
  }
  async function syncedManager(options: Parameters<typeof createCfg>[0] = {}, force?: true) {
    const manager = await getPersistentManager(createCfg(options));
    await manager.sync({ reason: "test", force });
    return manager;
  }
  function keywordConfig(options: Parameters<typeof createCfg>[0] = {}) {
    providerFixture.forceNoProvider = true;
    return createCfg({ provider: "none", minScore: 0, ...options });
  }
  const matchingHit = (fields = { path: "memory/2026-01-12.md" }) =>
    expect.arrayContaining([expect.objectContaining(fields)]);
  function expectFixtureHit(results: Awaited<ReturnType<Manager["search"]>>) {
    expect(results).toEqual(matchingHit());
  }
  function interceptMaintenance(visit: (manager: Manager) => void | Promise<void>) {
    const get = MemoryIndexManager.get.bind(MemoryIndexManager);
    return vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await get(params);
      if (params.purpose === "maintenance" && acquired) {
        await visit(acquired);
      }
      return acquired;
    });
  }
  function interceptMemorySync(manager: Manager, after: () => Promise<void>) {
    const fields = manager as unknown as MaintenanceFields;
    const sync = fields.syncMemoryFiles.bind(manager);
    return vi.spyOn(fields, "syncMemoryFiles").mockImplementation(async (params) => {
      const result = await sync(params);
      await after();
      return result;
    });
  }
  function pauseMaintenance(observeReindex = false) {
    const operation = hold(() => undefined);
    const state = { closed: false, fields: undefined as MaintenanceFields | undefined };
    const spy = interceptMaintenance((manager) => {
      state.fields = manager as unknown as MaintenanceFields;
      if (observeReindex) {
        vi.spyOn(state.fields, "runInPlaceReindex");
      }
      const close = manager.close.bind(manager);
      vi.spyOn(manager, "close").mockImplementation(async () => {
        await close();
        state.closed = true;
      });
      interceptMemorySync(manager, operation.run);
    });
    return { ready: operation.entered, release: operation.release, state, spy };
  }

  it("reuses published facts across searches and observes the next publication", async () => {
    const manager = await getPersistentManager(keywordConfig());
    const publishedPath = path.join(fixture.paths.memory, "published.md");
    await fs.writeFile(publishedPath, "orchid publication canary");
    await manager.sync({ reason: "test", force: true });
    const first = await manager.search("orchid", { minScore: 0 });
    expect(first).toEqual(matchingHit({ path: "memory/published.md" }));
    using reads = vi.spyOn(memoryCpuWorkerRuntime, "runMemoryIndexRead");
    using keyword = vi.spyOn(memoryCpuWorkerRuntime, "runMemoryKeywordSearch");
    using state = vi.spyOn(memoryCpuWorkerRuntime, "runMemoryIndexState");
    expect(await manager.search("orchid", { minScore: 0 })).toEqual(first);
    expect(await manager.search("orchid", { minScore: 0 })).toEqual(first);
    expect(reads.mock.calls.filter(([, command]) => command.type === "index.facts")).toEqual([]);
    expect(state).not.toHaveBeenCalled();
    expect(keyword.mock.calls.map((call) => call[3])).toEqual([false, false]);

    await fs.writeFile(publishedPath, "iris publication canary");
    await manager.sync({ reason: "test" });
    expect(await manager.search("iris publication canary", { minScore: 0 })).toEqual(
      matchingHit({ path: "memory/published.md" }),
    );
  });

  it("invalidates keyword snapshots before changing the fallback provider", async () => {
    const manager = await syncedManager({ fallback: "fallback-provider", minScore: 0 });
    const fallbackGate = createDeferred<void>();
    const query = hold(() => {
      throw new Error("embedding provider failed");
    });
    providerFixture.providerInitGate = fallbackGate.promise;
    const querySpy = vi.spyOn(provider(manager), "embed").mockImplementation(query.run);
    const snapshots: Array<Awaited<ReturnType<typeof manager.search>> | null> = [];
    const search = manager.search("zebra", {
      maxResults: 1,
      minScore: 0,
      onPartialResults: (results) => snapshots.push(results),
    });
    try {
      await query.entered;
      expect(snapshots).toEqual([[expect.objectContaining({ path: "memory/2026-01-12.md" })]]);
      query.release();
      await vi.waitFor(() =>
        expect(providerFixture.providerCalls.at(-1)?.provider).toBe("fallback-provider"),
      );
      expect(snapshots.at(-1)).toBeNull();
    } finally {
      query.release();
      fallbackGate.resolve();
      await search.catch(() => undefined);
      querySpy.mockRestore();
      providerFixture.providerInitGate = null;
    }
  });

  it("rejects a query whose dimensions no longer match the index", async () => {
    const manager = await syncedManager({ provider: "openai" }, true);
    const query = vi.spyOn(provider(manager), "embed").mockResolvedValue([1, 1, 1, 1, 1, 1]);

    await expect(manager.search("alpha")).rejects.toThrow(
      "query embedding has 6 dimensions, but the memory index expects 4",
    );
    expect(query).toHaveBeenCalledTimes(1);

    query.mockRestore();
    expectFixtureHit(await manager.search("alpha"));
  });

  it("keeps configured provider fallback available after query dimension drift", async () => {
    const manager = await syncedManager(
      { provider: "openai", fallback: "fallback-provider" },
      true,
    );
    vi.spyOn(provider(manager), "embed").mockResolvedValue([1, 0]);

    expect(await manager.search("alpha")).toEqual([]);
    expect(manager.status().provider).toBe("fallback-provider");
    await manager.sync({ reason: "test", force: true });
    expectFixtureHit(await manager.search("alpha"));
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
    const manager = await syncedManager();
    const close = vi.fn(async () => {});
    const embed = vi.fn(async () => [1, 0, 0, 0]);
    const fields = manager as unknown as {
      provider: EmbeddingProvider;
      providerKey: string;
      providerLifecycle: { mode: "active"; providerId: string };
      computeProviderKey: () => string;
    };
    fields.provider = {
      id: "local",
      model: "mock-embed",
      embed,
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
    expect(embed).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("rejects admitted keyword cancellation before embedding", async () => {
    const manager = await syncedManager({ minScore: 0 });
    const caller = new AbortController();
    const abortReason = new Error("caller stopped keyword memory search");
    const runKeywordSearch = memoryCpuWorkerRuntime.runMemoryKeywordSearch;
    using keywordSpy = vi
      .spyOn(memoryCpuWorkerRuntime, "runMemoryKeywordSearch")
      .mockImplementationOnce((...args) => {
        const pending = runKeywordSearch(...args);
        caller.abort(abortReason);
        return pending;
      });
    const embeddingCalls = providerFixture.embedQueryCalls;

    await expect(
      manager.search("zebra", { signal: caller.signal, lexicalOnly: false }),
    ).rejects.toBe(abortReason);
    expect(keywordSpy).toHaveBeenCalledTimes(1);
    expect(providerFixture.embedQueryCalls).toBe(embeddingCalls);
    expectFixtureHit(await manager.search("zebra", { lexicalOnly: false }));
  });

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
      using vectorSearch = vi.spyOn(memoryCpuWorkerRuntime, "runMemoryVectorFallback");
      const query = mode === "vector" ? "alpha zebra" : "zebra";
      const embeddingCalls = providerFixture.embedQueryCalls;
      try {
        await expect(manager.search(query, { lexicalOnly: false })).rejects.toMatchObject({
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
        const closed = capacityOwner.close();
        preparation.reject(new Error("release test capacity"));
        await closed;
        await accepted;
      }
      expectFixtureHit(await manager.search(query, { lexicalOnly: false }));
    },
  );

  it("rejects caller cancellation during hybrid fallback scanning", async () => {
    const manager = await syncedManager({ minScore: 0, vectorEnabled: false });

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
    {
      using vectorSpy = vi
        .spyOn(memoryCpuWorkerRuntime, "runMemoryVectorFallback")
        .mockImplementationOnce((...args) => {
          const pending = runVectorFallback(...args);
          caller.abort(abortReason);
          return pending;
        });
      await expect(manager.search("alpha", { signal: caller.signal })).rejects.toBe(abortReason);
      expect(vectorSpy).toHaveBeenCalledTimes(1);
    }

    expectFixtureHit(await manager.search("alpha"));

    const unavailable = vi
      .spyOn(memoryCpuWorkerRuntime, "runMemoryVectorFallback")
      .mockRejectedValueOnce(new Error("vector store unavailable"));
    try {
      expectFixtureHit(await manager.search("alpha"));
    } finally {
      unavailable.mockRestore();
    }
  });

  it("keeps zero-hit keyword fallback in one provider-backed worker request", async () => {
    const manager = await syncedManager({ minScore: 0.35 });

    using keywordSpy = vi.spyOn(memoryCpuWorkerRuntime, "runMemoryKeywordSearch");
    const partialResults = vi.fn();

    const results = await manager.search(
      "zebra project router gateway session transcript approval command owner workspace token budget retry queue",
      { maxResults: 5, onPartialResults: partialResults },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("memory/2026-01-12.md");
    expect(results.length).toBeLessThanOrEqual(5);
    expect(partialResults).toHaveBeenCalledWith(matchingHit());
    expect(keywordSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps remember-only session transcripts out of ordinary manager searches", async () => {
    const manager = await getFreshManager(keywordConfig({ rememberAcrossConversations: true }));
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

    const query = "Recall-only canary NEBULA-47";
    await expect(manager.search(query, { minScore: 0 })).resolves.toEqual([]);
    const trustedResults = await manager.search(query, {
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
    const manager = await getPersistentManager(
      keywordConfig({ sources: ["memory", "sessions"], sessionMemory: true }),
    );
    await manager.sync({ reason: "test", force: true });
    const searchCurrent = () =>
      manager.search("current dirty search sync", { maxResults: 5, minScore: 0 });
    const content = "Current memory appears only after the dirty search sync.";
    await fs.writeFile(path.join(fixture.paths.memory, "search-sync.md"), content);
    markDirty(manager);
    const maintenance = pauseMaintenance(true);

    try {
      const firstSearch = manager.search("zebra", { maxResults: 5, minScore: 0 });
      await maintenance.ready;
      expect(manager.status()).toMatchObject({ dirty: true });
      expect(maintenance.state.fields!.runInPlaceReindex).toHaveBeenCalledTimes(1);

      expectFixtureHit(await firstSearch);
      await expect(searchCurrent()).resolves.toEqual([]);

      maintenance.release();
      await serving(manager).awaitManagerIdle();
      expect(manager.status().dirty).toBe(false);

      expect(await searchCurrent()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "memory", snippet: expect.stringContaining(content) }),
        ]),
      );
      expect(maintenance.state.closed).toBe(true);
    } finally {
      maintenance.release();
      await serving(manager).awaitManagerIdle();
      maintenance.spy.mockRestore();
    }
  });

  it("rebuilds automatic maintenance from the revision after a concurrent memory purge", async () => {
    const cfg = keywordConfig({ sources: ["memory"] });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test", force: true });

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
    markDirty(manager);

    const shadowReady = createDeferred<void>();
    const releasePublish = createDeferred<void>();
    let syncCalls = 0;
    const getSpy = interceptMaintenance((acquired) => {
      interceptMemorySync(acquired, async () => {
        syncCalls += 1;
        if (syncCalls === 1) {
          shadowReady.resolve();
          await releasePublish.promise;
        }
      });
    });

    try {
      const search = manager.search("zebra", { maxResults: 5, minScore: 0 });
      await shadowReady.promise;
      await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: [sessionId] });
      releasePublish.resolve();

      expectFixtureHit(await search);
      await serving(manager).awaitManagerIdle();
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
      await serving(manager).awaitManagerIdle();
      getSpy.mockRestore();
    }
  });

  it("publishes transient CLI search maintenance before close, off the serving write path", async () => {
    const cfg = keywordConfig();
    const initialManager = await getFreshManager(cfg, "cli");
    await initialManager.sync({ reason: "test", force: true });
    await initialManager.close?.();
    await fs.writeFile(
      path.join(fixture.paths.memory, "cli-refresh.md"),
      "Content published after transient CLI maintenance.",
    );

    const manager = await getFreshManager(cfg, "cli", true);
    const servingFields = manager as unknown as MaintenanceFields;
    const servingSync = vi.spyOn(servingFields, "syncMemoryFiles");
    let closePromise: Promise<void> | undefined;
    const maintenance = pauseMaintenance();
    const idleEntered = createDeferred<void>();
    const awaitIdle = serving(manager).awaitManagerIdle.bind(manager);
    const idleSettled = vi.fn();
    using idle = vi.spyOn(serving(manager), "awaitManagerIdle");
    idle.mockImplementation(() => {
      const pending = awaitIdle();
      void pending.then(idleSettled, idleSettled);
      idleEntered.resolve();
      return pending;
    });

    try {
      const search = manager.search("zebra", {
        maxResults: 5,
        minScore: 0,
        sessionKey: "agent:main:cli:memory-search",
      });
      await maintenance.ready;
      expectFixtureHit(await search);
      expect(servingSync).not.toHaveBeenCalled();
      closePromise = manager.close();
      // Teardown must not release the connection the paused maintenance writes through.
      await idleEntered.promise;
      expect(idleSettled).not.toHaveBeenCalled();
      expect(maintenance.state.closed).toBe(false);
      maintenance.release();
      await closePromise;
      expect(maintenance.state.closed).toBe(true);
    } finally {
      maintenance.release();
      await closePromise;
      maintenance.spy.mockRestore();
      await manager.close?.();
    }

    // A standalone CLI process exits after close; the refresh it started is published.
    const next = await getFreshManager(cfg, "cli");
    try {
      expect(
        await next.search("transient", {
          maxResults: 5,
          minScore: 0,
          sessionKey: "agent:main:cli:memory-search",
        }),
      ).toEqual(matchingHit({ path: "memory/cli-refresh.md" }));
      expect(next.status().lastSyncError).toBeUndefined();
    } finally {
      await next.close?.();
    }
  });

  it("does not let a no-op sync hide a later detached failure", async () => {
    const manager = await getPersistentManager(createCfg({ provider: "none", minScore: 0 }));
    await manager.sync({ reason: "baseline" });
    const maintenanceWork = hold(() => {
      throw new Error("older maintenance failed");
    });
    const maintenance = {
      adoptReindexRetryState: vi.fn(),
      sync: vi.fn(maintenanceWork.run),
      close: vi.fn(async () => {}),
    };
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockResolvedValue(maintenance as never);
    Reflect.set(manager, "dirty", true);
    const detachedSync = serving(manager).syncPublishedIndexInBackground({ reason: "search" });

    try {
      await maintenanceWork.entered;
      expect(manager.status().dirty).toBe(false);
      await manager.sync({ reason: "interval" });
      maintenanceWork.release();
      await expect(detachedSync).rejects.toThrow("older maintenance failed");

      expect(manager.status()).toMatchObject({
        dirty: true,
        lastSyncError: expect.stringContaining("older maintenance failed"),
      });

      await manager.sync({ reason: "retry" });
      expect(manager.status().lastSyncError).toBeUndefined();
    } finally {
      maintenanceWork.release();
      await detachedSync.catch(() => undefined);
      getSpy.mockRestore();
    }
  });

  it("restores a maintenance generation when a null fallback leaves it dirty", async () => {
    const manager = await syncedManager({ fallback: "fallback-provider", minScore: 0 }, true);
    await fs.writeFile(
      path.join(fixture.paths.memory, "null-fallback.md"),
      "New content that requires a fallback embedding.",
    );
    markDirty(manager);
    providerFixture.providerNullResult = "fallback-provider";
    const getSpy = interceptMaintenance(async (acquired) => {
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
    });

    try {
      await expect(
        serving(manager).syncPublishedIndexInBackground({ reason: "search" }),
      ).resolves.toBeUndefined();

      expect(manager.status()).toMatchObject({
        dirty: true,
        lastSyncError: expect.stringContaining("Local embedding worker exited"),
      });
      expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);
    } finally {
      providerFixture.providerNullResult = null;
      getSpy.mockRestore();
    }
  });
});
