import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import {
  resolveMemoryFallbackProviderRequest,
  resolveMemoryPrimaryProviderRequest,
  resolveMemoryProviderState,
} from "./manager-provider-state.js";

const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

vi.mock("./embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embeddings.js")>()),
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  resolveEmbeddingProviderFallbackModel: (providerId: string, fallbackSourceModel: string) =>
    providerId === "ollama" ? DEFAULT_OLLAMA_EMBEDDING_MODEL : fallbackSourceModel,
}));

type EmbeddingProviderRuntime = {
  id: string;
  cacheKeyData: { provider: string; model: string };
};

function createProvider(id: string): EmbeddingProvider {
  return {
    id,
    model: `${id}-model`,
    embed: async () => [0.1, 0.2, 0.3],
    embedBatch: async (inputs) => inputs.map(() => [0.1, 0.2, 0.3]),
  };
}

function createSettings(params: {
  provider: "openai" | "mistral";
  fallback?: "none" | "mistral" | "ollama" | "lmstudio";
}): ResolvedMemorySearchConfig {
  return {
    provider: params.provider,
    model: params.provider === "mistral" ? "mistral/mistral-embed" : "text-embedding-3-small",
    fallback: params.fallback ?? "none",
    remote: undefined,
    outputDimensionality: undefined,
    local: undefined,
  } as unknown as ResolvedMemorySearchConfig;
}

type MemoryFallbackProviderRequest = NonNullable<
  ReturnType<typeof resolveMemoryFallbackProviderRequest>
>;

function expectMemoryFallbackRequest(
  request: ReturnType<typeof resolveMemoryFallbackProviderRequest>,
): MemoryFallbackProviderRequest {
  if (!request) {
    throw new Error("Expected memory fallback provider request");
  }
  return request;
}

describe("memory manager mistral provider wiring", () => {
  it("stores mistral client after fallback activation", () => {
    const mistralRuntime: EmbeddingProviderRuntime = {
      id: "mistral",
      cacheKeyData: { provider: "mistral", model: "mistral-embed" },
    };
    const mistralProvider = createProvider("mistral");
    const fallbackState = resolveMemoryProviderState({
      provider: mistralProvider,
      runtime: mistralRuntime,
      requestedProvider: "openai",
      fallbackFrom: "openai",
      fallbackReason: "forced test",
    });

    expect(fallbackState.fallbackFrom).toBe("openai");
    expect(fallbackState.fallbackReason).toBe("forced test");
    expect(fallbackState.provider).toBe(mistralProvider);
    expect(fallbackState.providerRuntime).toBe(mistralRuntime);
  });

  it("resolves a fallback provider as available", () => {
    const fallbackState = resolveMemoryProviderState({
      provider: createProvider("openai"),
      requestedProvider: "local",
      fallbackFrom: "local",
      fallbackReason: "worker crashed",
    });

    expect(fallbackState.providerUnavailableReason).toBeUndefined();
    expect(fallbackState.lifecycle).toEqual({
      mode: "fallback-active",
      providerId: "openai",
      fallbackFrom: "local",
      reason: "worker crashed",
    });
  });

  it("keeps the primary endpoint and credentials out of the runtime fallback", () => {
    const provider = "ollama";
    const model = DEFAULT_OLLAMA_EMBEDDING_MODEL;
    const sharedRemote = {
      nonBatchConcurrency: 3,
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
      apiKey: "test-key",
      headers: {
        Authorization: "Bearer test-secret",
        "X-OpenAI-Secret": "test-token",
      },
      ...sharedRemote,
    };
    const local = { modelPath: "/tmp/synthetic-memory-model.gguf", contextSize: 2048 };
    const settings = {
      ...createSettings({ provider: "openai", fallback: provider }),
      remote,
      inputType: "passage",
      queryInputType: "query",
      documentInputType: "document",
      outputDimensionality: 768,
      local,
    } satisfies ResolvedMemorySearchConfig;

    const primaryRequest = resolveMemoryPrimaryProviderRequest({ settings });
    expect(primaryRequest.remote).toBe(remote);
    expect(primaryRequest).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      outputDimensionality: 768,
      inputType: "passage",
      queryInputType: "query",
      documentInputType: "document",
    });

    const fallbackRequest = expectMemoryFallbackRequest(
      resolveMemoryFallbackProviderRequest({
        cfg: {} as OpenClawConfig,
        settings,
        currentProviderId: "openai",
      }),
    );

    expect(fallbackRequest).toMatchObject({
      provider,
      model,
      fallback: "none",
      remote: sharedRemote,
      inputType: "passage",
      queryInputType: "query",
      documentInputType: "document",
      outputDimensionality: 768,
      local,
    });
    expect(fallbackRequest.remote).toEqual(sharedRemote);
  });

  it("does not activate a fallback that is already the current provider", () => {
    expect(
      resolveMemoryFallbackProviderRequest({
        cfg: {} as OpenClawConfig,
        settings: createSettings({ provider: "openai", fallback: "lmstudio" }),
        currentProviderId: "lmstudio",
      }),
    ).toBeNull();
  });
});
