// Memory Core tests cover manager provider lifecycle lease behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import * as generationLease from "./manager-index-generation-lease.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const { createConfig: createCfg, getFreshManager, getPersistentManager, trackManager } = fixture;

  it("keeps an active FTS-only generation stable while fallback activates", async () => {
    const manager = await getFreshManager(
      createCfg({ provider: "openai", fallback: "fallback-provider" }),
      "cli",
    );
    trackManager(manager);
    type IndexEntry = {
      path: string;
      absPath: string;
      mtimeMs: number;
      size: number;
      hash: string;
      content: string;
    };
    const fields = manager as unknown as {
      provider: { id: string } | null;
      providerKey: string;
      computeProviderKey: () => string;
      ensureProviderInitialized: () => Promise<void>;
      markLocalEmbeddingProviderDegraded: (err: unknown) => void;
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      beginSyncProviderGeneration: () => void;
      endSyncProviderGeneration: () => void;
      indexFile: (entry: IndexEntry, source: "memory") => Promise<void>;
      db: {
        prepare: (sql: string) => {
          get: (...params: unknown[]) => { model?: string } | undefined;
        };
      };
    };
    await fields.ensureProviderInitialized();
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.id = "local";
    fields.providerKey = fields.computeProviderKey();
    fields.markLocalEmbeddingProviderDegraded(providerFixture.createLocalWorkerExitError());
    await vi.waitFor(() => {
      expect(fields.provider).toBeNull();
      expect(providerFixture.providerCloseCalls).toBe(1);
    });

    const createEntry = (name: string): IndexEntry => {
      const content = `# Log\n${name} FTS-only generation.`;
      return {
        path: `memory/${name}.md`,
        absPath: path.join(fixture.paths.memory, `${name}.md`),
        mtimeMs: Date.now(),
        size: Buffer.byteLength(content),
        hash: hashText(content),
        content,
      };
    };
    const first = createEntry("fts-first");
    const second = createEntry("fts-second");
    await fs.writeFile(first.absPath, first.content);
    await fs.writeFile(second.absPath, second.content);

    fields.beginSyncProviderGeneration();
    try {
      await fields.indexFile(first, "memory");
      await expect(fields.activateFallbackProvider("local worker exited")).resolves.toBe(true);
      await fields.indexFile(second, "memory");
    } finally {
      fields.endSyncProviderGeneration();
    }

    expect(
      fields.db.prepare("SELECT model FROM memory_index_chunks WHERE path = ?").get(first.path)
        ?.model,
    ).toBe("fts-only");
    expect(
      fields.db.prepare("SELECT model FROM memory_index_chunks WHERE path = ?").get(second.path)
        ?.model,
    ).toBe("fts-only");
  });

  it("waits for admitted provider users before retirement", async () => {
    const cfg = createCfg({ provider: "openai" });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: {
        embed: (text: string) => Promise<number[]>;
      } | null;
      retireCurrentProvider: () => Promise<void>;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    const firstQueryGate = createDeferred<void>();
    const firstQueryStarted = createDeferred<void>();
    fields.provider.embed = async () => {
      firstQueryStarted.resolve();
      await firstQueryGate.promise;
      return [1, 0, 0, 0];
    };

    const queryPromise = manager.search("alpha");
    await firstQueryStarted.promise;
    const retirementPromise = fields.retireCurrentProvider();
    const retirementSettled = vi.fn();
    void retirementPromise.then(retirementSettled, retirementSettled);
    try {
      await Promise.resolve();
      expect(retirementSettled).not.toHaveBeenCalled();
      expect(providerFixture.providerCloseCalls).toBe(0);
    } finally {
      firstQueryGate.resolve();
    }

    await expect(queryPromise).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
    );
    await retirementPromise;
    expect(providerFixture.providerCloseCalls).toBe(1);
  });

  it("uses the leased provider runtime after retirement starts", async () => {
    const manager = await getPersistentManager(createCfg({ provider: "openai" }));
    type QueryProvider = {
      embed: (text: string, options?: { signal?: AbortSignal }) => Promise<number[]>;
    };
    const fields = manager as unknown as {
      provider: QueryProvider | null;
      providerRuntime?: { inlineQueryTimeoutMs?: number };
      acquireProviderUse: (provider: QueryProvider) => () => void;
      retireCurrentProvider: () => Promise<void>;
      embedQueryWithRetry: (
        text: string,
        signal: AbortSignal | undefined,
        provider: QueryProvider,
        providerRuntime: { inlineQueryTimeoutMs?: number },
      ) => Promise<number[]>;
    };
    await manager.probeEmbeddingAvailability();
    const provider = fields.provider;
    if (!provider) {
      throw new Error("Expected a test embedding provider");
    }
    const providerRuntime = { inlineQueryTimeoutMs: 10 };
    fields.providerRuntime = providerRuntime;
    provider.embed = async (_text, options) =>
      await new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => resolve([1, 0, 0, 0]), 100);
        options?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const reason = options.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("embedding aborted"));
          },
          { once: true },
        );
      });

    const releaseProvider = fields.acquireProviderUse(provider);
    const retirementPromise = fields.retireCurrentProvider();
    try {
      await vi.waitFor(() => expect(fields.provider).toBeNull());
      await expect(
        fields.embedQueryWithRetry("alpha", undefined, provider, providerRuntime),
      ).rejects.toThrow("timed out");
      expect(providerFixture.providerCloseCalls).toBe(0);
    } finally {
      releaseProvider();
    }

    await retirementPromise;
    expect(providerFixture.providerCloseCalls).toBe(1);
  });

  it("waits for an admitted search before manager teardown", async () => {
    const manager = await getPersistentManager(createCfg({ provider: "openai" }));
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      searchVector: () => Promise<{ results: unknown[]; candidates: unknown[] }>;
      closing: boolean;
      closed: boolean;
    };
    const vectorSearchGate = createDeferred<void>();
    const vectorSearchStarted = createDeferred<void>();
    fields.searchVector = async () => {
      vectorSearchStarted.resolve();
      await vectorSearchGate.promise;
      return { results: [], candidates: [] };
    };

    const generationReleaseStarted = createDeferred<void>();
    const generationReleaseGate = createDeferred<void>();
    const acquireGeneration = generationLease.acquireMemoryIndexReadGeneration;
    vi.spyOn(generationLease, "acquireMemoryIndexReadGeneration").mockImplementationOnce(
      async (...args) => {
        const release = await acquireGeneration(...args);
        return async () => {
          generationReleaseStarted.resolve();
          await generationReleaseGate.promise;
          await release();
        };
      },
    );
    const searchPromise = manager.search("alpha");
    await vectorSearchStarted.promise;
    const closePromise = manager.close();
    const closeSettled = vi.fn();
    void closePromise.then(closeSettled, closeSettled);
    try {
      await Promise.resolve();
      expect(closeSettled).not.toHaveBeenCalled();
      expect(fields.closing).toBe(true);
      expect(fields.closed).toBe(false);
      expect(providerFixture.providerCloseCalls).toBe(0);
      vectorSearchGate.resolve();
      await generationReleaseStarted.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closeSettled).not.toHaveBeenCalled();
      expect(providerFixture.providerCloseCalls).toBe(0);
    } finally {
      vectorSearchGate.resolve();
      generationReleaseGate.resolve();
      await Promise.allSettled([searchPromise, closePromise]);
    }

    await expect(searchPromise).resolves.toBeDefined();
    await closePromise;
    expect(providerFixture.providerCloseCalls).toBe(1);
  });

  it("waits for an admitted vector probe before manager teardown", async () => {
    const manager = await getPersistentManager(createCfg({ provider: "openai" }));
    const fields = manager as unknown as {
      ensureVectorReady: () => Promise<boolean>;
    };
    const probeGate = createDeferred<void>();
    const probeStarted = createDeferred<void>();
    fields.ensureVectorReady = async () => {
      probeStarted.resolve();
      await probeGate.promise;
      return true;
    };

    const probePromise = manager.probeVectorAvailability();
    await probeStarted.promise;
    const closePromise = manager.close();
    const closeSettled = vi.fn();
    void closePromise.then(closeSettled, closeSettled);
    try {
      await Promise.resolve();
      expect(closeSettled).not.toHaveBeenCalled();
      expect(providerFixture.providerCloseCalls).toBe(0);
    } finally {
      probeGate.resolve();
    }

    await expect(probePromise).resolves.toBe(true);
    await closePromise;
    expect(providerFixture.providerCloseCalls).toBe(1);
  });

  it("fails closed when fallback initialization fails for an explicit provider", async () => {
    const cfg = createCfg({
      provider: "openai",
      fallback: "fallback-provider",
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: {
        embed: (text: string) => Promise<number[]>;
      } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };
    providerFixture.providerCreationFailure = "fallback-provider";

    await expect(manager.search("alpha")).rejects.toThrow(
      /Memory search unavailable: embedding provider "openai" is configured but unavailable\./,
    );

    providerFixture.providerCreationFailure = null;
    await expect(manager.search("alpha")).resolves.toBeDefined();
  });

  it("retries the optional primary after fallback initialization fails", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: {
        id: string;
        embed: (text: string) => Promise<number[]>;
      } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };
    providerFixture.providerCreationFailure = "fallback-provider";
    const callsBeforeSearch = providerFixture.providerCalls.length;

    await expect(manager.search("alpha")).resolves.toBeDefined();

    providerFixture.providerCreationFailure = null;
    await expect(manager.search("alpha")).resolves.toBeDefined();
    expect(
      providerFixture.providerCalls.slice(callsBeforeSearch).map((call) => call.provider),
    ).toEqual(["fallback-provider", "openai"]);
    expect(fields.provider?.id).toBe("mock");
  });

  it("fails closed and retries a required primary after a null fallback result", async () => {
    const cfg = createCfg({ provider: "openai", fallback: "fallback-provider" });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: { embed: (text: string) => Promise<number[]> } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };
    providerFixture.providerNullResult = "fallback-provider";

    await expect(manager.search("alpha")).rejects.toThrow(
      /Memory search unavailable: embedding provider "openai" is configured but unavailable\./,
    );

    providerFixture.providerNullResult = null;
    await expect(manager.search("alpha")).resolves.toBeDefined();
  });

  it("retries an optional primary after a null fallback result", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: { id: string; embed: (text: string) => Promise<number[]> } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };
    providerFixture.providerNullResult = "fallback-provider";

    await expect(manager.search("alpha")).resolves.toBeDefined();

    providerFixture.providerNullResult = null;
    await expect(manager.search("alpha")).resolves.toBeDefined();
    expect(fields.provider?.id).toBe("mock");
  });

  it("keeps concurrent optional searches in FTS mode when shared fallback fails", async () => {
    const cfg = createCfg({ fallback: "fallback-provider" });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: {
        embed: (text: string) => Promise<number[]>;
      } | null;
      ensureProviderInitialized: () => Promise<void>;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };
    const ensureProviderInitialized = fields.ensureProviderInitialized.bind(manager);
    let providerInitializationCalls = 0;
    fields.ensureProviderInitialized = async () => {
      providerInitializationCalls += 1;
      await ensureProviderInitialized();
    };
    providerFixture.providerCreationFailure = "fallback-provider";
    const providerInit = createDeferred<void>();
    providerFixture.providerInitGate = providerInit.promise;

    const callsBeforeSearch = providerFixture.providerCalls.length;
    const firstSearch = manager.search("alpha");
    await vi.waitFor(() =>
      expect(
        providerFixture.providerCalls.some((call) => call.provider === "fallback-provider"),
      ).toBe(true),
    );
    const initializationCallsBeforeSecondSearch = providerInitializationCalls;
    const secondSearch = manager.search("zebra");
    const secondSettled = vi.fn();
    void secondSearch.then(secondSettled, secondSettled);
    try {
      await vi.waitFor(() =>
        expect(providerInitializationCalls).toBeGreaterThan(initializationCallsBeforeSecondSearch),
      );
      expect(secondSettled).not.toHaveBeenCalled();
      providerInit.resolve();
      const results = await Promise.all([firstSearch, secondSearch]);
      expect(results.every((result) => result.length > 0)).toBe(true);
      expect(
        providerFixture.providerCalls
          .slice(callsBeforeSearch)
          .filter((call) => call.provider === "fallback-provider"),
      ).toHaveLength(1);
    } finally {
      providerFixture.providerInitGate = null;
      providerInit.resolve();
      await Promise.allSettled([firstSearch, secondSearch]);
    }
  });
});
