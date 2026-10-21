import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexManager } from "./manager.js";

const memoryIndex = await import("./index.js");

describe("memory index", () => {
  const fixture = createManagerIndexFixture(memoryIndex);
  const { provider: providerFixture } = fixture;
  const { createConfig: createCfg, getFreshManager, getPersistentManager } = fixture;
  const fieldsOf = (manager: Awaited<ReturnType<typeof getFreshManager>>) =>
    manager as unknown as { provider: EmbeddingProvider | null; providerInitialized: boolean };
  const failedProvider = (id: string, model: string): EmbeddingProvider => {
    const fail = async (): Promise<never> => {
      throw providerFixture.createLocalWorkerExitError();
    };
    return { id, model, embed: fail, embedBatch: fail, close: async () => {} };
  };
  const expectAlpha = (results: Awaited<ReturnType<MemoryIndexManager["search"]>>) =>
    expect(results).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
    );

  it("returns to the primary after a query outage without rebuilding its index", async () => {
    const manager = await getPersistentManager(createCfg({ fallback: "fallback-provider" }));
    await manager.sync({ reason: "test" });
    expectAlpha(await manager.search("alpha"));
    const indexedInputs = [...providerFixture.embeddedBatchTexts];

    providerFixture.beforeEmbedQuery = async () => {
      throw providerFixture.createLocalWorkerExitError();
    };
    expect(await manager.search("alpha outage")).toEqual([]);
    expect(manager.status().provider).toBe("fallback-provider");
    expect(await manager.search("alpha still offline")).toEqual([]);
    expect(manager.status().provider).toBe("fallback-provider");

    providerFixture.beforeEmbedQuery = null;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      const recovered = await Promise.all([
        manager.search("alpha recovered"),
        manager.search("alpha concurrent recovery"),
      ]);
      for (const results of recovered) {
        expectAlpha(results);
      }
      expect(manager.status().provider).toBe("mock");
      expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
      expect(providerFixture.embeddedBatchTexts).toEqual(indexedInputs);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not activate fallback during search when index identity is already mismatched", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
    });
    const manager = await getPersistentManager(cfg);

    await manager.sync({ reason: "test" });
    const callsBeforeSearch = providerFixture.providerCalls.length;
    (
      manager as unknown as {
        provider: {
          id: string;
          model: string;
          embed: () => Promise<number[]>;
          embedBatch: (texts: string[]) => Promise<number[][]>;
          close: () => Promise<void>;
        };
      }
    ).provider = {
      id: "local",
      model: "mock-embed",
      embed: async () => {
        throw providerFixture.createLocalWorkerExitError();
      },
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
      close: async () => {},
    };

    const results = await manager.search("alpha");

    expect(results).toStrictEqual([]);
    expect(providerFixture.providerCalls.slice(callsBeforeSearch)).toStrictEqual([]);
    expect(
      (
        manager as unknown as {
          provider: { id: string } | null;
        }
      ).provider?.id,
    ).toBe("local");
  });

  it("reports the adopted fallback provider when the published index belongs to it", async () => {
    // Status must adopt the published fallback identity just as search does.
    const publishCfg = createCfg({
      provider: "fallback-provider",
      model: "fallback-provider-embed",
    });
    const publisher = await getFreshManager(publishCfg);
    await publisher.sync({ reason: "test", force: true });
    await publisher.close?.();

    const cfg = createCfg({ model: "mock-embed", fallback: "fallback-provider" });

    const searchManager = await getFreshManager(cfg);
    const results = await searchManager.search("alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(searchManager.status().provider).toBe("fallback-provider");
    await searchManager.close?.();

    const statusManager = await getFreshManager(cfg);
    const probe = await statusManager.probeEmbeddingAvailability();
    const status = statusManager.status();

    expect(probe.ok).toBe(true);
    expect(status).toMatchObject({
      provider: "fallback-provider",
      model: "fallback-provider-embed",
      custom: { providerState: { mode: "fallback-active" } },
    });
    expect(status.custom?.indexIdentity).toEqual({ status: "valid" });
  });

  it("keeps probing the configured provider when the published index matches it", async () => {
    const cfg = createCfg({ fallback: "fallback-provider" });
    const publisher = await getFreshManager(cfg);
    await publisher.sync({ reason: "test", force: true });
    await publisher.close?.();

    const statusManager = await getFreshManager(cfg);
    const probe = await statusManager.probeEmbeddingAvailability();
    const status = statusManager.status();

    expect(probe.ok).toBe(true);
    expect(status.provider).toBe("mock");
    expect(status.custom?.providerState).toMatchObject({ mode: "active" });
  });

  it("rebuilds with fallback provider during explicit identity repair", async () => {
    const oldManager = await getFreshManager(createCfg({ model: "old-embed" }));
    await oldManager.sync({ reason: "test", force: true });
    await oldManager.close?.();

    const manager = await getFreshManager(
      createCfg({ model: "new-embed", fallback: "fallback-provider" }),
    );
    expect(manager.status().dirty).toBe(true);
    const fields = fieldsOf(manager);
    fields.providerInitialized = true;
    fields.provider = failedProvider("mock", "new-embed");

    await manager.sync({ reason: "cli" });

    expect(manager.status()).toMatchObject({
      dirty: false,
      provider: "fallback-provider",
      model: "fallback-provider-embed",
    });
    expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    await expect(manager.search("alpha")).resolves.not.toStrictEqual([]);
  });

  it("adopts a configured fallback index published by detached maintenance", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
      model: "new-embed",
    });
    const maintenanceManager = await getFreshManager(cfg);
    const maintenanceFields = maintenanceManager as unknown as {
      providerInitialized: boolean;
      provider: {
        id: string;
        model: string;
        embed: (text: string) => Promise<number[]>;
        embedBatch: (texts: string[]) => Promise<number[][]>;
        close: () => Promise<void>;
      };
    };
    maintenanceFields.providerInitialized = true;
    maintenanceFields.provider = {
      id: "mock",
      model: "new-embed",
      embed: async () => {
        throw providerFixture.createLocalWorkerExitError();
      },
      embedBatch: async () => {
        throw providerFixture.createLocalWorkerExitError();
      },
      close: async () => {},
    };
    await maintenanceManager.sync({ reason: "search", force: true });
    expect(maintenanceManager.status()).toMatchObject({
      provider: "fallback-provider",
      model: "fallback-provider-embed",
      custom: { indexIdentity: { status: "valid" } },
    });
    await maintenanceManager.close?.();

    const manager = await getFreshManager(cfg);
    // The existing serving manager handed its dirty generation to maintenance
    // before the fallback index was published. Do not model a separate startup scan.
    Reflect.set(manager, "dirty", false);
    const callsBeforeSearch = providerFixture.providerCalls.length;

    const results = await manager.search("alpha");

    expect(results).not.toStrictEqual([]);
    expect(providerFixture.providerCalls.slice(callsBeforeSearch)).toContainEqual(
      expect.objectContaining({ provider: "fallback-provider" }),
    );
    expect(manager.status()).toMatchObject({
      provider: "fallback-provider",
      model: "fallback-provider-embed",
    });
    expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
  });

  it("reinitializes the configured provider after probe-time local degradation", async () => {
    const manager = await getPersistentManager(createCfg({ fallback: "fallback-provider" }));

    await manager.sync({ reason: "test" });
    fieldsOf(manager).provider = failedProvider("local", "mock-embed");
    const callsBeforeSearch = providerFixture.providerCalls.length;

    await expect(manager.probeEmbeddingAvailability()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Local embedding worker exited"),
    });

    const results = await manager.search("alpha");

    expect(results.length).toBeGreaterThan(0);
    expect(
      providerFixture.providerCalls.slice(callsBeforeSearch).map((call) => call.provider),
    ).toContain("openai");
    expect(fieldsOf(manager).provider?.id).toBe("mock");
  });

  it("clears identity dirty after status resolves the indexed fallback provider", async () => {
    const indexedCfg = createCfg({
      provider: "fallback-provider",
      model: "new-embed",
    });
    const indexedManager = await getFreshManager(indexedCfg);
    await indexedManager.sync({ reason: "test", force: true });
    await indexedManager.close?.();

    const cfg = createCfg({
      fallback: "fallback-provider",
      model: "new-embed",
    });
    const manager = await getFreshManager(cfg, "status");
    try {
      expect(manager.status().dirty).toBe(true);

      const fields = manager as unknown as {
        provider: {
          id: string;
          model: string;
          embed: (text: string) => Promise<number[]>;
          embedBatch: (texts: string[]) => Promise<number[][]>;
          close: () => Promise<void>;
        };
        providerInitialized: boolean;
        providerRuntime: {
          id: string;
          cacheKeyData: Record<string, unknown>;
        };
        providerKey: string;
        computeProviderKey: () => string;
      };
      fields.provider = {
        id: "fallback-provider",
        model: "new-embed",
        embed: async () => [1, 0, 0, 0],
        embedBatch: async (texts) => texts.map(() => [1, 0, 0, 0]),
        close: async () => {},
      };
      fields.providerRuntime = {
        id: "fallback-provider",
        cacheKeyData: {
          provider: "fallback-provider",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          model: "new-embed",
          headers: [],
        },
      };
      fields.providerInitialized = true;
      fields.providerKey = fields.computeProviderKey();

      expect(manager.status().dirty).toBe(false);
      expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    } finally {
      await manager.close?.();
    }
  });

  it("exposes already-created local runtime facts without probing embeddings", async () => {
    const manager = await getFreshManager(createCfg({}), "status");
    const getRuntimeFacts = vi.fn(() => ({
      engine: "llama.cpp" as const,
      state: "ready" as const,
      backend: "cuda" as const,
      buildType: "prebuilt" as const,
      deviceNames: ["NVIDIA Test GPU"],
      offload: { supported: true, offloadedLayers: 24, totalLayers: 24 },
      context: { requestedSize: 4096 },
    }));
    const provider: EmbeddingProvider = {
      id: "local",
      model: "test-model.gguf",
      embed: vi.fn(async () => [1, 0, 0, 0]),
      embedBatch: vi.fn<EmbeddingProvider["embedBatch"]>(async (texts) =>
        texts.map(() => [1, 0, 0, 0]),
      ),
    };
    Object.defineProperty(provider, Symbol.for("openclaw.localEmbeddingRuntimeFacts"), {
      value: getRuntimeFacts,
    });
    fieldsOf(manager).provider = provider;

    expect(manager.status().custom?.llamaCppRuntime).toMatchObject({
      state: "ready",
      backend: "cuda",
      deviceNames: ["NVIDIA Test GPU"],
      offload: { offloadedLayers: 24, totalLayers: 24 },
      context: { requestedSize: 4096 },
    });
    expect(getRuntimeFacts).toHaveBeenCalledTimes(1);
  });

  it("fails fast instead of searching FTS when an explicit provider is unavailable", async () => {
    providerFixture.forceNoProvider = true;

    const manager = await getFreshManager(createCfg({ provider: "openai", minScore: 0.35 }));
    await expect(manager.search("Alpha")).rejects.toThrow(
      /Memory search unavailable: embedding provider "openai" is configured but unavailable\.[\s\S]*agentId=main purpose=default[\s\S]*registeredMemoryEmbeddingProviders=openai-compatible/,
    );
    await expect(manager.sync({ reason: "test" })).rejects.toThrow(
      /Memory sync unavailable: embedding provider "openai" is configured but unavailable\./,
    );
    providerFixture.forceNoProvider = false;
    await manager.sync({ reason: "test", force: true });
    const results = await manager.search("Alpha");
    expect(results.length).toBeGreaterThan(0);
  });

  it("fails fast instead of returning FTS when an explicit provider is lost at runtime", async () => {
    const cfg = createCfg({
      provider: "openai",
      minScore: 0.35,
    });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test", force: true });
      (
        manager as unknown as {
          provider: null;
        }
      ).provider = null;

      await expect(manager.search("Alpha")).rejects.toThrow(
        /Memory search unavailable: embedding provider "openai" is configured but unavailable\./,
      );
    } finally {
      await manager.close?.();
    }
  });
});
