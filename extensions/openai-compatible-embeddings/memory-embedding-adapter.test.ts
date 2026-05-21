import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOpenAICompatibleEmbeddingProvider: vi.fn(),
}));

vi.mock("./embedding-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  createOpenAICompatibleEmbeddingProvider: mocks.createOpenAICompatibleEmbeddingProvider,
}));

import { openaiCompatibleMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

describe("openai-compatible memory embedding adapter", () => {
  beforeEach(() => {
    mocks.createOpenAICompatibleEmbeddingProvider.mockReset();
    mocks.createOpenAICompatibleEmbeddingProvider.mockResolvedValue({
      provider: {
        id: "openai-compatible",
        model: "text-embedding-bge-m3",
        embedQuery: async () => [1, 0],
        embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
      },
      client: {
        baseUrl: "http://localhost:8081/v1",
        headers: {
          authorization: "Bearer <redacted>",
          "content-type": "application/json",
        },
        model: "text-embedding-bge-m3",
      },
    });
  });

  it("declares a remote provider with no auto-select and no auth dependency", () => {
    // The openai-compatible provider must not auto-select. Auto-selection
    // would route embeddings to a local server the operator may not have
    // running, or worse, could hide a misconfigured production setup.
    expect(openaiCompatibleMemoryEmbeddingProviderAdapter.id).toBe("openai-compatible");
    expect(openaiCompatibleMemoryEmbeddingProviderAdapter.transport).toBe("remote");
    expect(openaiCompatibleMemoryEmbeddingProviderAdapter.autoSelectPriority).toBeUndefined();
    expect(openaiCompatibleMemoryEmbeddingProviderAdapter.authProviderId).toBeUndefined();
    expect(openaiCompatibleMemoryEmbeddingProviderAdapter.allowExplicitWhenConfiguredAuto).toBe(
      true,
    );
    expect(openaiCompatibleMemoryEmbeddingProviderAdapter.create).toBeTypeOf("function");
    expect(
      openaiCompatibleMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection,
    ).toBeUndefined();
  });

  it("does not invoke any warmup or preload during create", async () => {
    // Regression: the lmstudio adapter calls `ensureLmstudioModelLoaded`
    // here and that hangs for ~30 seconds against servers that do not
    // implement LMStudio's load endpoint. The openai-compatible adapter
    // must skip any such pre-call: a single `create` invocation should
    // produce one synchronous factory call and no additional side
    // effects.
    await openaiCompatibleMemoryEmbeddingProviderAdapter.create({
      config: {} as never,
      provider: "openai-compatible",
      model: "text-embedding-bge-m3",
      fallback: "none",
      remote: { baseUrl: "http://localhost:8081/v1", apiKey: "test" },
    });

    expect(mocks.createOpenAICompatibleEmbeddingProvider).toHaveBeenCalledTimes(1);
  });

  it("exposes the configured baseUrl and model in the cache key (not a global one)", async () => {
    mocks.createOpenAICompatibleEmbeddingProvider.mockResolvedValueOnce({
      provider: {
        id: "openai-compatible",
        model: "text-embedding-bge-m3",
        embedQuery: async () => [1, 0],
        embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
      },
      client: {
        baseUrl: "http://localhost:8081/v1",
        headers: {
          "content-type": "application/json",
        },
        model: "text-embedding-bge-m3",
        dimensions: 1024,
      },
    });

    const result = await openaiCompatibleMemoryEmbeddingProviderAdapter.create({
      config: {} as never,
      provider: "openai-compatible",
      model: "text-embedding-bge-m3",
      fallback: "none",
      remote: { baseUrl: "http://localhost:8081/v1" },
    });

    expect(result.runtime?.cacheKeyData).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8081/v1",
      model: "text-embedding-bge-m3",
      dimensions: 1024,
    });
  });

  it("strips Authorization from the cache key so a rotated bearer does not invalidate cached embeddings", async () => {
    const result = await openaiCompatibleMemoryEmbeddingProviderAdapter.create({
      config: {} as never,
      provider: "openai-compatible",
      model: "text-embedding-bge-m3",
      fallback: "none",
      remote: { baseUrl: "http://localhost:8081/v1", apiKey: "secret" },
    });

    const cacheHeaders = (result.runtime?.cacheKeyData as { headers?: Record<string, string> })
      ?.headers;
    expect(cacheHeaders).toBeDefined();
    expect(cacheHeaders).not.toHaveProperty("authorization");
  });
});
