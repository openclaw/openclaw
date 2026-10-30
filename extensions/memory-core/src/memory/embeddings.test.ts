import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { EmbeddingProviderAdapter } from "openclaw/plugin-sdk/embedding-providers";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddingProvider,
  resolveEmbeddingProviderFallbackModel,
  resolveEmbeddingProviderFallbackRemote,
  resolveEmbeddingProviderIndexIdentity,
} from "./embeddings.js";

const mockEmbeddingRegistry = vi.hoisted(() => ({
  genericAdapters: [] as EmbeddingProviderAdapter[],
  adapters: [] as MemoryEmbeddingProviderAdapter[],
  genericLookupConfigs: [] as Array<OpenClawConfig | undefined>,
  acquireLocalService: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")
  >()),
  createLocalEmbeddingProvider: async () => {
    throw new Error("local embedding provider is not used by these tests");
  },
  getMemoryEmbeddingProvider: (id: string, config?: OpenClawConfig) => {
    const memoryAdapter = mockEmbeddingRegistry.adapters.find((adapter) => adapter.id === id);
    if (memoryAdapter) {
      return memoryAdapter;
    }
    mockEmbeddingRegistry.genericLookupConfigs.push(config);
    const genericAdapter = mockEmbeddingRegistry.genericAdapters.find(
      (adapter) => adapter.id === id,
    );
    if (!genericAdapter) {
      return undefined;
    }
    return genericAdapter;
  },
}));

const missingBedrockCredentialsError = new Error(
  'No API key found for provider "bedrock". AWS credentials are not available.',
);

function createOptions(
  provider: string,
  acquireLocalService = mockEmbeddingRegistry.acquireLocalService,
) {
  return {
    config: { plugins: { enabled: false } } as OpenClawConfig,
    agentDir: "/tmp/openclaw-agent",
    provider,
    fallback: "none",
    model: "",
    acquireLocalService,
  };
}

function createMissingCredentialsAdapter(
  overrides: Partial<MemoryEmbeddingProviderAdapter> = {},
): MemoryEmbeddingProviderAdapter {
  return {
    id: "bedrock",
    transport: "remote",
    autoSelectPriority: 60,
    formatSetupError: coerceErrorMessage,
    create: async () => {
      throw missingBedrockCredentialsError;
    },
    ...overrides,
  };
}

function createConstantEmbeddingProvider(
  id: string,
  model: string,
  coordinate: number,
): MemoryEmbeddingProvider {
  return {
    id,
    model,
    embed: async () => [coordinate],
    embedBatch: async (texts) => texts.map(() => [coordinate]),
  };
}

function clearTestMemoryAdapters(): void {
  mockEmbeddingRegistry.genericAdapters = [];
  mockEmbeddingRegistry.adapters = [];
  mockEmbeddingRegistry.genericLookupConfigs = [];
}

function registerGenericEmbeddingProvider(adapter: EmbeddingProviderAdapter): void {
  mockEmbeddingRegistry.genericAdapters.push(adapter);
}

function registerTestMemoryAdapter(adapter: MemoryEmbeddingProviderAdapter): void {
  mockEmbeddingRegistry.adapters.push(adapter);
}

describe("createEmbeddingProvider", () => {
  beforeEach(() => {
    clearTestMemoryAdapters();
    mockEmbeddingRegistry.acquireLocalService.mockReset();
  });

  it("uses the provider's canonical model for cold identity and creation without inventing a cache key", async () => {
    registerTestMemoryAdapter({
      id: "Tenant",
      normalizeModel: ({ model }) => model.replace(/^Tenant\//, ""),
      create: async ({ model }) => ({
        provider: createConstantEmbeddingProvider("Tenant", model, 1),
      }),
    });
    const options = { ...createOptions("Tenant"), model: " Tenant/embed-v1 " };
    expect(resolveEmbeddingProviderIndexIdentity(options)).toEqual({
      provider: { id: "Tenant", model: "embed-v1" },
      cacheKeyData: undefined,
      aliases: undefined,
    });
    expect((await createEmbeddingProvider(options)).provider?.model).toBe("embed-v1");
    expect(resolveEmbeddingProviderIndexIdentity({ ...options, model: "" })?.provider).toEqual({
      id: "Tenant",
      model: "",
    });
  });

  it.each(["none", "NoNe"])("preserves the primary error with fallback %s", async (fallback) => {
    registerTestMemoryAdapter(createMissingCredentialsAdapter());

    await expect(
      createEmbeddingProvider({ ...createOptions("bedrock"), fallback }),
    ).rejects.toThrow(missingBedrockCredentialsError.message);
  });

  it("drops the fallback remote config when it contains only primary-provider fields", () => {
    expect(resolveEmbeddingProviderFallbackRemote(undefined)).toBeUndefined();
    expect(
      resolveEmbeddingProviderFallbackRemote({
        baseUrl: "https://primary-openai.invalid/v1",
        apiKey: "synthetic-primary-openai-api-key",
        headers: { Authorization: "Bearer synthetic-primary-openai-auth" },
      }),
    ).toBeUndefined();
  });

  it("does not retry the primary provider as its own fallback", async () => {
    const create = vi.fn<MemoryEmbeddingProviderAdapter["create"]>(async () => {
      throw new Error("synthetic primary provider unavailable");
    });
    registerTestMemoryAdapter({ id: "openai", create });

    await expect(
      createEmbeddingProvider({ ...createOptions("openai"), fallback: "openai" }),
    ).rejects.toThrow("synthetic primary provider unavailable");

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps the primary endpoint and credentials out of the creation fallback", async () => {
    const fallback = "ollama";
    const primaryCreate = vi.fn<MemoryEmbeddingProviderAdapter["create"]>(async () => {
      throw new Error("synthetic primary provider unavailable");
    });
    const fallbackCreate = vi.fn<MemoryEmbeddingProviderAdapter["create"]>(async () => ({
      provider: createConstantEmbeddingProvider(fallback, `${fallback}-embedding`, 1),
    }));
    registerTestMemoryAdapter({ id: "openai", create: primaryCreate });
    registerTestMemoryAdapter({ id: fallback, create: fallbackCreate });

    const sharedRemote = {
      batch: {
        enabled: true,
        wait: false,
        concurrency: 2,
        pollIntervalMs: 250,
        timeoutMinutes: 5,
      },
    };
    const remote = {
      baseUrl: "https://primary-openai.invalid/v1",
      apiKey: "synthetic-primary-openai-api-key",
      headers: {
        Authorization: "Bearer synthetic-primary-openai-auth",
        "X-OpenAI-Secret": "synthetic-primary-openai-header",
      },
      ...sharedRemote,
    };
    const fallbackProviderConfig = {
      baseUrl: `https://${fallback}-provider.invalid/v1`,
      apiKey: "synthetic-fallback-owned-api-key",
      headers: { "X-Fallback-Auth": "synthetic-fallback-owned-header" },
      models: [],
    };
    const primaryOptions = createOptions("openai");
    const config = {
      ...primaryOptions.config,
      models: { providers: { [fallback]: fallbackProviderConfig } },
    } satisfies OpenClawConfig;
    const local = { modelPath: "/tmp/synthetic-memory-model.gguf", contextSize: 2048 };

    const result = await createEmbeddingProvider({
      ...primaryOptions,
      config,
      fallback,
      model: "text-embedding-3-small",
      remote,
      inputType: "passage",
      queryInputType: "query",
      documentInputType: "document",
      outputDimensionality: 768,
      local,
    });

    expect(primaryCreate.mock.calls[0]?.[0]).toMatchObject({ remote, config });
    expect(fallbackCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: fallback,
        remote: sharedRemote,
        config,
        agentDir: primaryOptions.agentDir,
        acquireLocalService: primaryOptions.acquireLocalService,
        model: "text-embedding-3-small",
        inputType: "passage",
        queryInputType: "query",
        documentInputType: "document",
        dimensions: 768,
        fallback: "none",
        local,
      }),
    );
    expect(fallbackCreate.mock.calls[0]?.[0].remote).toEqual(sharedRemote);
    expect(result).toMatchObject({
      requestedProvider: "openai",
      fallbackFrom: "openai",
      provider: { id: fallback },
    });
  });

  it.each([
    { name: "fallback that serves its own model", fallbackDefaultModel: "nomic-embed-text" },
    { name: "fallback without a default model", fallbackDefaultModel: undefined },
  ])("hands the creation fallback the model it serves: $name", async ({ fallbackDefaultModel }) => {
    const primaryModel = "text-embedding-3-small";
    const fallbackCreate = vi.fn<MemoryEmbeddingProviderAdapter["create"]>(async ({ model }) => ({
      provider: createConstantEmbeddingProvider("ollama", model, 1),
    }));
    registerTestMemoryAdapter({
      id: "openai",
      defaultModel: primaryModel,
      create: async () => {
        throw new Error("synthetic primary provider unavailable");
      },
    });
    registerTestMemoryAdapter({
      id: "ollama",
      ...(fallbackDefaultModel ? { defaultModel: fallbackDefaultModel } : {}),
      create: fallbackCreate,
    });

    const options = { ...createOptions("openai"), model: primaryModel, fallback: "ollama" };
    const result = await createEmbeddingProvider(options);

    const runtimeActivationModel = resolveEmbeddingProviderFallbackModel(
      "ollama",
      primaryModel,
      options.config,
    );
    const expectedModel = fallbackDefaultModel ?? primaryModel;
    expect(runtimeActivationModel).toBe(expectedModel);
    expect(fallbackCreate).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama", model: expectedModel }),
    );
    expect(result.provider?.model).toBe(expectedModel);
  });

  it.each(["auto", "Auto"])(
    "resolves %s to the default provider without auto-selection",
    async (provider) => {
      registerTestMemoryAdapter(createMissingCredentialsAdapter({ autoSelectPriority: 10 }));
      registerTestMemoryAdapter({
        id: "openai",
        transport: "remote",
        autoSelectPriority: 20,
        create: async () => ({
          provider: createConstantEmbeddingProvider("openai", "text-embedding-3-small", 1),
        }),
      });

      const options = createOptions(provider);
      expect(resolveEmbeddingProviderIndexIdentity(options)?.provider.id).toBe("openai");
      const result = await createEmbeddingProvider(options);

      expect(result).toMatchObject({ provider: { id: "openai" }, requestedProvider: "openai" });
    },
  );

  it("uses config-scoped generic defaults for creation, cold identity, and fallback", async () => {
    registerGenericEmbeddingProvider({
      id: "openai-compatible",
      defaultModel: "generic-default",
      create: async ({ model }) => ({
        provider: createConstantEmbeddingProvider("generic", model, 1),
      }),
    });
    const options = createOptions("openai-compatible");

    expect((await createEmbeddingProvider(options)).provider).toMatchObject({
      id: "generic",
      model: "generic-default",
    });
    expect(resolveEmbeddingProviderIndexIdentity(options)?.provider).toEqual({
      id: "openai-compatible",
      model: "generic-default",
    });
    expect(
      resolveEmbeddingProviderFallbackModel("openai-compatible", "source-model", options.config),
    ).toBe("generic-default");
    expect(mockEmbeddingRegistry.genericLookupConfigs).toEqual([
      options.config,
      options.config,
      options.config,
    ]);
  });

  it("keeps concurrent provider creation bound to each caller's local-service hook", async () => {
    const observedHooks: unknown[] = [];
    registerGenericEmbeddingProvider({
      id: "openai-compatible",
      create: async (options) => {
        observedHooks.push(
          (options as typeof options & { acquireLocalService?: unknown }).acquireLocalService,
        );
        await Promise.resolve();
        return {
          provider: createConstantEmbeddingProvider("generic", "generic-model", 1),
        };
      },
    });
    const firstAcquire = vi.fn(async () => undefined);
    const secondAcquire = vi.fn(async () => undefined);

    await Promise.all([
      createEmbeddingProvider(createOptions("openai-compatible", firstAcquire)),
      createEmbeddingProvider(createOptions("openai-compatible", secondAcquire)),
    ]);

    expect(observedHooks).toEqual([firstAcquire, secondAcquire]);
  });

  it("keeps memory-specific providers authoritative during dual registration", async () => {
    registerGenericEmbeddingProvider({
      id: "openai-compatible",
      create: async () => ({
        provider: createConstantEmbeddingProvider("generic", "generic-model", 1),
      }),
    });
    registerTestMemoryAdapter({
      id: "openai-compatible",
      create: async () => ({
        provider: createConstantEmbeddingProvider("legacy", "legacy-model", 0),
      }),
    });

    const result = await createEmbeddingProvider(createOptions("openai-compatible"));

    expect(result.provider?.id).toBe("legacy");
    await expect(result.provider?.embed("hello", { inputType: "query" })).resolves.toEqual([0]);
  });

  it("reports the llama.cpp plugin install command when local is unregistered", async () => {
    await expect(createEmbeddingProvider(createOptions("local"))).rejects.toThrow(
      "openclaw plugins install @openclaw/llama-cpp-provider",
    );
  });
});
