import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay, setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { EmbeddingProvider } from "openclaw/plugin-sdk/embedding-providers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  hashText,
  type MemoryFileEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import * as generationLease from "./manager-index-generation-lease.js";
import {
  createManagerIndexFixture,
  holdMemoryTestOperation as hold,
} from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

type QueryRuntime = { inlineQueryTimeoutMs?: number };
type LifecycleFields = {
  provider: EmbeddingProvider | null;
  providerKey: string;
  providerRuntime?: QueryRuntime;
  closing: boolean;
  closed: boolean;
  db: DatabaseSync;
  computeProviderKey: () => string;
  ensureProviderInitialized: () => Promise<void>;
  markLocalEmbeddingProviderDegraded: (err: unknown) => void;
  activateFallbackProvider: (reason: string) => Promise<boolean>;
  beginSyncProviderGeneration: () => void;
  endSyncProviderGeneration: () => void;
  indexFile: (entry: MemoryFileEntry, source: "memory") => Promise<void>;
  retireCurrentProvider: () => Promise<void>;
  acquireProviderUse: (provider: EmbeddingProvider) => () => void;
  embedQueryWithRetry: (
    text: string,
    signal: AbortSignal | undefined,
    provider: EmbeddingProvider,
    runtime: QueryRuntime,
  ) => Promise<number[]>;
  searchVector: () => Promise<{ results: unknown[]; candidates: unknown[] }>;
  ensureVectorReady: () => Promise<boolean>;
};
describe("memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const { createConfig: createCfg, getFreshManager, getPersistentManager } = fixture;
  async function open(
    params: Parameters<typeof createCfg>[0] = { provider: "openai" },
    sync = false,
  ) {
    const manager = await getPersistentManager(createCfg(params));
    if (sync) {
      await manager.sync({ reason: "test" });
    }
    return { manager, fields: manager as unknown as LifecycleFields };
  }

  it("keeps an active FTS-only generation stable while fallback activates", async () => {
    const manager = await getFreshManager(
      createCfg({ provider: "openai", fallback: "fallback-provider" }),
      "cli",
    );
    const fields = manager as unknown as LifecycleFields;
    await fields.ensureProviderInitialized();
    assert.ok(fields.provider, "Expected a test embedding provider");
    fields.provider.id = "local";
    fields.providerKey = fields.computeProviderKey();
    fields.markLocalEmbeddingProviderDegraded(providerFixture.createLocalWorkerExitError());
    await vi.waitFor(() => {
      expect(fields.provider).toBeNull();
      expect(providerFixture.providerCloseCalls).toBe(1);
    });

    const createEntry = (name: string) => {
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
      [first, second].map(
        (entry) =>
          fields.db.prepare("SELECT model FROM memory_index_chunks WHERE path = ?").get(entry.path)
            ?.model,
      ),
    ).toEqual(["fts-only", "fts-only"]);
  });

  it("waits for admitted provider users before retirement", async () => {
    const { manager, fields } = await open(undefined, true);
    assert.ok(fields.provider, "Expected a test embedding provider");
    const firstQueryGate = hold(() => [1, 0, 0, 0]);
    fields.provider.embed = firstQueryGate.run;

    const queryPromise = manager.search("alpha");
    await firstQueryGate.entered;
    const retirementPromise = fields.retireCurrentProvider();
    const retirementSettled = vi.fn();
    void retirementPromise.then(retirementSettled, retirementSettled);
    try {
      await Promise.resolve();
      expect(retirementSettled).not.toHaveBeenCalled();
      expect(providerFixture.providerCloseCalls).toBe(0);
    } finally {
      firstQueryGate.release();
    }

    await expect(queryPromise).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
    );
    await retirementPromise;
    expect(providerFixture.providerCloseCalls).toBe(1);
  });

  it("uses the leased provider runtime after retirement starts", async () => {
    const { manager, fields } = await open();
    await manager.probeEmbeddingAvailability();
    const provider = fields.provider;
    assert.ok(provider, "Expected a test embedding provider");
    const providerRuntime = { inlineQueryTimeoutMs: 10 };
    fields.providerRuntime = providerRuntime;
    provider.embed = async (_text, options) => {
      try {
        return await delay(100, [1, 0, 0, 0], { signal: options?.signal });
      } catch {
        const reason = options?.signal?.reason;
        throw reason instanceof Error ? reason : new Error("embedding aborted");
      }
    };

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
    const { manager, fields } = await open(undefined, true);
    const vectorSearchGate = hold(() => ({ results: [], candidates: [] }));
    fields.searchVector = vectorSearchGate.run;

    const generationRelease = hold(() => {});
    const acquireGeneration = generationLease.acquireMemoryIndexReadGeneration;
    vi.spyOn(generationLease, "acquireMemoryIndexReadGeneration").mockImplementationOnce(
      async (...args) => {
        const release = await acquireGeneration(...args);
        return async () => {
          await generationRelease.run();
          await release();
        };
      },
    );
    const searchPromise = manager.search("alpha");
    await vectorSearchGate.entered;
    const closePromise = manager.close();
    const closeSettled = vi.fn();
    void closePromise.then(closeSettled, closeSettled);
    try {
      await Promise.resolve();
      expect(closeSettled).not.toHaveBeenCalled();
      expect(fields).toMatchObject({ closing: true, closed: false });
      expect(providerFixture.providerCloseCalls).toBe(0);
      vectorSearchGate.release();
      await generationRelease.entered;
      await yieldToEventLoop();
      expect(closeSettled).not.toHaveBeenCalled();
      expect(providerFixture.providerCloseCalls).toBe(0);
    } finally {
      vectorSearchGate.release();
      generationRelease.release();
      await Promise.allSettled([searchPromise, closePromise]);
    }

    await expect(searchPromise).resolves.toBeDefined();
    await closePromise;
    expect(providerFixture.providerCloseCalls).toBe(1);
  });

  it("waits for an admitted vector probe before manager teardown", async () => {
    const { manager, fields } = await open();
    const probeGate = hold(() => true);
    fields.ensureVectorReady = probeGate.run;

    const probePromise = manager.probeVectorAvailability();
    await probeGate.entered;
    const closePromise = manager.close();
    const closeSettled = vi.fn();
    void closePromise.then(closeSettled, closeSettled);
    try {
      await Promise.resolve();
      expect(closeSettled).not.toHaveBeenCalled();
      expect(providerFixture.providerCloseCalls).toBe(0);
    } finally {
      probeGate.release();
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
    const { manager, fields } = await open(
      { provider: "openai", fallback: "fallback-provider" },
      true,
    );
    assert.ok(fields.provider, "Expected a test embedding provider");
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
    const { manager, fields } = await open({ fallback: "fallback-provider" }, true);
    assert.ok(fields.provider, "Expected a test embedding provider");
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };
    const initialization = vi.spyOn(fields, "ensureProviderInitialized");
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
    const callsBeforeSecond = initialization.mock.calls.length;
    const secondSearch = manager.search("zebra");
    const secondSettled = vi.fn();
    void secondSearch.then(secondSettled, secondSettled);
    try {
      await vi.waitFor(() =>
        expect(initialization.mock.calls.length).toBeGreaterThan(callsBeforeSecond),
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
