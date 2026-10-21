import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexWorkItem } from "./manager-sync-base.js";

type LifecycleFields = {
  provider: EmbeddingProvider | null;
  providerKey: string;
  computeProviderKey: () => string;
  ensureProviderInitialized: () => Promise<void>;
  resetProviderInitializationForRetry: () => void;
  markLocalEmbeddingProviderDegraded: (error: unknown) => void;
  activateFallbackProvider: (reason: string) => Promise<boolean>;
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>;
  indexFile: (entry: MemoryIndexWorkItem["entry"], source: "memory") => Promise<void>;
  ensureVectorReady: (dimensions?: number) => Promise<boolean>;
  db: DatabaseSync;
};

const memoryIndex = await import("./index.js");

describe("memory index", () => {
  const fixture = createManagerIndexFixture(memoryIndex);
  const { provider: providerFixture } = fixture;
  const {
    createConfig: createCfg,
    getFreshManager,
    getPersistentManager,
    requireManager,
    trackManager,
  } = fixture;
  const fieldsOf = (manager: Awaited<ReturnType<typeof getFreshManager>>) =>
    manager as unknown as LifecycleFields;
  async function syncedManager(params: Parameters<typeof createCfg>[0]) {
    const manager = await getPersistentManager(createCfg(params));
    await manager.sync({ reason: "test" });
    return { manager, fields: fieldsOf(manager) };
  }
  function holdProviderClose() {
    const gate = createDeferred<void>();
    providerFixture.providerCloseGate = gate.promise;
    return () => {
      gate.resolve();
      providerFixture.providerCloseGate = null;
    };
  }
  const providersSince = (index: number) =>
    providerFixture.providerCalls.slice(index).map((call) => call.provider);

  it.each([false, true])(
    "drains startup transcript discovery before closing (scan failure: %s)",
    async (failScan) => {
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      await fs.mkdir(sessionsDir, { recursive: true });
      const scanStarted = createDeferred<void>();
      const scanGate = createDeferred<void>();
      const scanFinished = createDeferred<void>();
      const realReaddir = fs.readdir;
      const readdirSpy = vi
        .spyOn(fs, "readdir")
        .mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
          if (path.resolve(String(args[0])) !== sessionsDir) {
            return await realReaddir(...args);
          }
          scanStarted.resolve();
          try {
            await scanGate.promise;
            if (failScan) {
              throw Object.assign(new Error("transcript scan failed"), { code: "EIO" });
            }
            return await realReaddir(...args);
          } finally {
            scanFinished.resolve();
          }
        });
      let closing: Promise<void> | undefined;
      try {
        const manager = await getPersistentManager(
          createCfg({
            provider: "none",
            sources: ["sessions"],
            rememberAcrossConversations: true,
          }),
        );
        await scanStarted.promise;
        let closed = false;
        closing = manager.close().then(() => {
          closed = true;
        });
        await yieldToEventLoop();
        expect(closed).toBe(false);
        scanGate.resolve();
        await closing;
        expect(closed).toBe(true);
      } finally {
        scanGate.resolve();
        await closing;
        await scanFinished.promise;
        await yieldToEventLoop();
        readdirSpy.mockRestore();
      }
    },
  );

  it("caches embedding probe readiness across transient status managers", async () => {
    const cfg = createCfg({});
    const first = requireManager(
      await memoryIndex.getMemorySearchManager({ cfg, agentId: "main", purpose: "status" }),
    );
    trackManager(first);

    await expect(first.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    expect(providerFixture.embedQueryCalls).toBe(1);
    await first.close();

    const second = requireManager(
      await memoryIndex.getMemorySearchManager({ cfg, agentId: "main", purpose: "status" }),
    );
    trackManager(second);

    const cachedBeforeProbe = second.getCachedEmbeddingAvailability?.();
    expect(cachedBeforeProbe?.ok).toBe(true);
    expect(cachedBeforeProbe?.checked).toBe(true);
    expect(cachedBeforeProbe?.cached).toBe(true);
    expect(cachedBeforeProbe?.checkedAtMs).toBeTypeOf("number");
    expect(cachedBeforeProbe?.cacheExpiresAtMs).toBeTypeOf("number");
    if (
      typeof cachedBeforeProbe?.checkedAtMs === "number" &&
      typeof cachedBeforeProbe.cacheExpiresAtMs === "number"
    ) {
      expect(cachedBeforeProbe.cacheExpiresAtMs - cachedBeforeProbe.checkedAtMs).toBe(30_000);
    }
    await expect(second.probeEmbeddingAvailability()).resolves.toStrictEqual({
      ok: true,
      checked: true,
      cached: true,
      checkedAtMs: cachedBeforeProbe?.checkedAtMs,
      cacheExpiresAtMs: cachedBeforeProbe?.cacheExpiresAtMs,
    });
    expect(providerFixture.embedQueryCalls).toBe(1);

    const cached = second.getCachedEmbeddingAvailability?.();
    expect((cached?.cacheExpiresAtMs ?? 0) - (cached?.checkedAtMs ?? 0)).toBe(30_000);
  });

  it("clears cached embedding probe readiness when local embeddings degrade", async () => {
    const manager = await getPersistentManager(createCfg({}));

    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    expect(manager.getCachedEmbeddingAvailability()?.ok).toBe(true);
    const fields = fieldsOf(manager);
    fields.provider = {
      id: "local",
      model: "local-model",
      embed: async () => [1, 0],
      embedBatch: async (texts) => texts.map(() => [1, 0]),
      close: async () => {},
    };

    fields.markLocalEmbeddingProviderDegraded(providerFixture.createLocalWorkerExitError());

    expect(manager.getCachedEmbeddingAvailability()).toBeNull();
    await expect(manager.probeEmbeddingAvailability()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Local embeddings degraded"),
    });
  });

  it.each(["degraded fallback", "retry"])(
    "waits for provider shutdown before %s initialization",
    async (mode) => {
      const { manager, fields } = await syncedManager(
        mode === "retry" ? { provider: "openai" } : { fallback: "fallback-provider" },
      );
      const releaseProviderClose = holdProviderClose();
      if (mode === "retry") {
        fields.resetProviderInitializationForRetry();
      } else {
        if (!fields.provider) {
          throw new Error("Expected a test embedding provider");
        }
        fields.provider.id = "local";
        fields.markLocalEmbeddingProviderDegraded(providerFixture.createLocalWorkerExitError());
      }
      await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));
      const callsBefore = providerFixture.providerCalls.length;
      const initialization =
        mode === "retry"
          ? manager.probeEmbeddingAvailability()
          : fields.activateFallbackProvider("local worker exited");
      try {
        await Promise.resolve();
        expect(providerFixture.providerCalls).toHaveLength(callsBefore);
      } finally {
        releaseProviderClose();
        await initialization;
      }
      expect(providersSince(callsBefore)).toEqual([
        mode === "retry" ? "openai" : "fallback-provider",
      ]);
    },
  );

  it("retries failed provider retirement before fallback initialization", async () => {
    const { fields } = await syncedManager({ fallback: "fallback-provider" });
    providerFixture.providerCloseFailuresRemaining = 1;
    const callsBeforeFallback = providerFixture.providerCalls.length;

    await expect(fields.activateFallbackProvider("provider failed")).rejects.toThrow(
      "provider close failed",
    );
    expect(providerFixture.providerCalls).toHaveLength(callsBeforeFallback);

    await expect(fields.activateFallbackProvider("provider failed")).resolves.toBe(true);
    expect(providerFixture.providerCloseCalls).toBe(2);
    expect(providersSince(callsBeforeFallback)).toEqual(["fallback-provider"]);
  });

  it("waits for active provider shutdown before fallback initialization", async () => {
    const { manager, fields } = await syncedManager({
      provider: "openai",
      fallback: "fallback-provider",
    });
    const releaseProviderClose = holdProviderClose();
    if (!fields.provider?.close) {
      throw new Error("Expected a test embedding provider");
    }
    const providerCloseStarted = createDeferred<void>();
    const closeProvider = fields.provider.close.bind(fields.provider);
    fields.provider.close = () => {
      const closing = closeProvider();
      providerCloseStarted.resolve();
      return closing;
    };
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };

    const callsBeforeSearch = providerFixture.providerCalls.length;
    const searchPromise = manager.search("alpha");
    let concurrentSearch: ReturnType<typeof manager.search> = Promise.resolve([]);
    try {
      await Promise.race([providerCloseStarted.promise, searchPromise]);
      expect(providerFixture.providerCloseCalls).toBe(1);
      concurrentSearch = manager.search("zebra");
      let concurrentSettled = false;
      const settle = () => {
        concurrentSettled = true;
      };
      void concurrentSearch.then(settle, settle);
      await Promise.resolve();
      expect(concurrentSettled).toBe(false);
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeSearch);
    } finally {
      releaseProviderClose();
      await Promise.allSettled([searchPromise, concurrentSearch]);
    }
  });

  it("leases the indexing provider generation through chunk publication", async () => {
    const manager = await getFreshManager(
      createCfg({ provider: "openai", fallback: "fallback-provider", cacheEnabled: true }),
      "cli",
    );
    const fields = fieldsOf(manager);
    await fields.ensureProviderInitialized();
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    const indexedProvider = fields.provider;
    indexedProvider.id = "local";
    fields.providerKey = fields.computeProviderKey();
    const indexedProviderKey = fields.providerKey;
    const firstContent = "# Log\nFirst memory line indexed during provider fallback.";
    const secondContent = "# Log\nSecond memory line indexed during provider fallback.";
    await fs.writeFile(path.join(fixture.paths.memory, "generation-race-first.md"), firstContent);
    await fs.writeFile(path.join(fixture.paths.memory, "generation-race-second.md"), secondContent);

    const firstEmbeddingGate = createDeferred<void>();
    const secondEmbeddingGate = createDeferred<void>();
    const firstEmbeddingStarted = createDeferred<void>();
    const secondEmbeddingStarted = createDeferred<void>();
    indexedProvider.embedBatch = async (texts) => {
      if (texts.some((text) => (typeof text === "string" ? text : text.text).includes("First"))) {
        firstEmbeddingStarted.resolve();
        await firstEmbeddingGate.promise;
      } else {
        secondEmbeddingStarted.resolve();
        await secondEmbeddingGate.promise;
      }
      return texts.map(() => [1, 0, 0, 0]);
    };
    const publicationGate = createDeferred<void>();
    const publicationStarted = createDeferred<void>();
    const ensureVectorReady = fields.ensureVectorReady.bind(manager);
    let publicationCalls = 0;
    fields.ensureVectorReady = async (dimensions) => {
      publicationCalls += 1;
      if (publicationCalls === 1) {
        return await ensureVectorReady(dimensions);
      }
      publicationStarted.resolve();
      await publicationGate.promise;
      return await ensureVectorReady(dimensions);
    };

    const callsBeforeFallback = providerFixture.providerCalls.length;
    const index = (name: string, content: string) =>
      fields.indexFile(
        {
          path: `memory/${name}`,
          absPath: path.join(fixture.paths.memory, name),
          mtimeMs: Date.now(),
          size: Buffer.byteLength(content),
          hash: hashText(content),
          content,
        },
        "memory",
      );
    const firstIndexPromise = index("generation-race-first.md", firstContent);
    const secondIndexPromise = index("generation-race-second.md", secondContent);
    let fallbackPromise: Promise<boolean> | null = null;
    try {
      const embeddingsStarted = Promise.all([
        firstEmbeddingStarted.promise,
        secondEmbeddingStarted.promise,
      ]);
      await fields.withTimeout(embeddingsStarted, 5_000, "concurrent embeddings did not start");
      fields.markLocalEmbeddingProviderDegraded(providerFixture.createLocalWorkerExitError());
      await vi.waitFor(() => expect(fields.provider).toBeNull());
      fallbackPromise = fields.activateFallbackProvider("local worker exited");
      firstEmbeddingGate.resolve();
      await firstIndexPromise;
      expect(providerFixture.providerCloseCalls).toBe(0);
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeFallback);

      secondEmbeddingGate.resolve();
      await fields.withTimeout(publicationStarted.promise, 5_000, "publication did not start");
      expect(providerFixture.providerCloseCalls).toBe(0);
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeFallback);

      publicationGate.resolve();
      await secondIndexPromise;
      await expect(fallbackPromise).resolves.toBe(true);
    } finally {
      firstEmbeddingGate.resolve();
      secondEmbeddingGate.resolve();
      publicationGate.resolve();
      await Promise.allSettled([
        firstIndexPromise,
        secondIndexPromise,
        ...(fallbackPromise ? [fallbackPromise] : []),
      ]);
    }

    expect(providersSince(callsBeforeFallback)).toEqual(["fallback-provider"]);
    expect(
      fields.db
        .prepare("SELECT model FROM memory_index_chunks WHERE path = ?")
        .get("memory/generation-race-second.md")?.model,
    ).toBe(indexedProvider.model);
    expect(
      fields.db
        .prepare("SELECT provider, model, provider_key FROM memory_embedding_cache LIMIT 1")
        .get(),
    ).toEqual({
      provider: indexedProvider.id,
      model: indexedProvider.model,
      provider_key: indexedProviderKey,
    });
  });
});
