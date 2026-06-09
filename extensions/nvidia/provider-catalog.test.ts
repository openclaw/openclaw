// Nvidia tests cover provider catalog plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLiveNvidiaProvider,
  buildNvidiaProvider,
  buildSelectableLiveNvidiaProvider,
  clearNvidiaFeaturedModelCacheForTests,
  NVIDIA_FEATURED_MODELS_URL,
} from "./provider-catalog.js";

const featuredCatalogFetchMock = vi.hoisted(() => vi.fn());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearNvidiaFeaturedModelCacheForTests();
  featuredCatalogFetchMock.mockReset();
});

function mockFeaturedCatalogResponse(payload: unknown, status = 200): void {
  vi.stubGlobal("fetch", featuredCatalogFetchMock);
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
  vi.stubEnv("OPENCLAW_PROXY_LOOPBACK_MODE", "gateway-only");
  featuredCatalogFetchMock.mockResolvedValueOnce(Response.json(payload, { status }));
}

describe("nvidia provider catalog", () => {
  it("builds the bundled NVIDIA provider defaults", () => {
    const provider = buildNvidiaProvider();

    expect(provider.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.apiKey).toBe("NVIDIA_API_KEY");
    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.7",
      "z-ai/glm-5.1",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
    expect(provider.models.filter((model) => model.compat?.requiresStringContent !== true)).toEqual(
      [],
    );
    expect(provider.models[0]).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 16_384,
      params: {
        chat_template_kwargs: {
          enable_thinking: false,
          force_nonempty_content: true,
        },
      },
    });
  });

  it("promotes ranked models from NVIDIA's featured catalog", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "z-ai/glm-5.1",
          "model-name": "GLM 5.1",
          context: 202752,
          "max-output": 8192,
        },
        {
          model: "nemotron-3-super-120b-a12b",
          "model-name": "Nemotron 3 Super 120B",
          context: 262144,
          "max-output": 8192,
        },
      ],
    });

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "z-ai/glm-5.1",
      "nvidia/nemotron-3-super-120b-a12b",
    ]);
    expect(provider.models[0]).toMatchObject({
      name: "GLM 5.1",
      contextWindow: 202752,
      maxTokens: 8192,
      compat: { requiresStringContent: true },
    });
    expect(featuredCatalogFetchMock).toHaveBeenCalledWith(
      NVIDIA_FEATURED_MODELS_URL,
      expect.objectContaining({
        headers: expect.any(Headers),
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("falls back to the bundled catalog when the featured catalog is unavailable", async () => {
    mockFeaturedCatalogResponse({ error: "unavailable" }, 503);

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.7",
      "z-ai/glm-5.1",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
  });

  it("retains shipped NVIDIA model refs as bundled fallback compatibility rows", () => {
    const provider = buildNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(["minimaxai/minimax-m2.5", "z-ai/glm5"]),
    );
  });

  it("uses only selectable live catalog rows when the featured catalog returns models", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "z-ai/glm-5.1",
          "model-name": "GLM 5.1",
          context: 202752,
          "max-output": 8192,
        },
        {
          model: "nemotron-3-super-120b-a12b",
          "model-name": "Nemotron 3 Super 120B",
          context: 262144,
          "max-output": 8192,
        },
      ],
    });

    const provider = await buildSelectableLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "z-ai/glm-5.1",
      "nvidia/nemotron-3-super-120b-a12b",
    ]);
  });

  it("returns no selectable live rows when the featured catalog is unavailable", async () => {
    mockFeaturedCatalogResponse({ error: "unavailable" }, 503);

    const provider = await buildSelectableLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([]);
  });

  it("ignores malformed featured catalog rows and keeps valid entries", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "bad model id",
          "model-name": "Bad",
          context: 1000,
          "max-output": 1000,
        },
        {
          model: "minimaxai/minimax-m2.7",
          "model-name": "Minimax M2.7",
          context: 196608,
          "max-output": 8192,
        },
        {
          model: "oversized-context",
          "model-name": "Oversized Context",
          context: 10_000_001,
          "max-output": 8192,
        },
      ],
    });

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual(["minimaxai/minimax-m2.7"]);
  });

  it("caches the featured catalog for repeated provider builds", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "minimaxai/minimax-m2.7",
          "model-name": "Minimax M2.7",
          context: 196608,
          "max-output": 8192,
        },
      ],
    });

    await buildLiveNvidiaProvider();
    await buildLiveNvidiaProvider();

    expect(featuredCatalogFetchMock).toHaveBeenCalledOnce();
  });

  it("skips featured catalog cache when ttl expiry overflows", async () => {
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "minimaxai/minimax-m2.7",
          "model-name": "Minimax M2.7",
          context: 196608,
          "max-output": 8192,
        },
      ],
    });
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "z-ai/glm-5.1",
          "model-name": "GLM 5.1",
          context: 202752,
          "max-output": 8192,
        },
      ],
    });

    const first = await buildLiveNvidiaProvider();
    const second = await buildLiveNvidiaProvider();

    expect(first.models.map((model) => model.id)).toEqual(["minimaxai/minimax-m2.7"]);
    expect(second.models.map((model) => model.id)).toEqual(["z-ai/glm-5.1"]);
    expect(featuredCatalogFetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache successful featured catalog responses with no usable rows", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "bad model id",
          "model-name": "Bad",
          context: 1000,
          "max-output": 1000,
        },
      ],
    });
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "z-ai/glm-5.1",
          "model-name": "GLM 5.1",
          context: 202752,
          "max-output": 8192,
        },
      ],
    });

    const first = await buildLiveNvidiaProvider();
    const second = await buildLiveNvidiaProvider();

    expect(first.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.7",
      "z-ai/glm-5.1",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
    expect(second.models.map((model) => model.id)).toEqual(["z-ai/glm-5.1"]);
    expect(featuredCatalogFetchMock).toHaveBeenCalledTimes(2);
  });

  it("applies bundled Ultra defaults when featured catalog returns Ultra", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "nemotron-3-ultra-550b-a55b",
          "model-name": "Nemotron 3 Ultra 550B",
          context: 1000000,
          "max-output": 16384,
        },
        {
          model: "minimaxai/minimax-m2.7",
          "model-name": "Minimax M2.7",
          context: 196608,
          "max-output": 8192,
        },
      ],
    });

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b",
      "minimaxai/minimax-m2.7",
    ]);
    expect(provider.models[0]).toMatchObject({
      name: "Nemotron 3 Ultra 550B",
      contextWindow: 1_000_000,
      maxTokens: 16_384,
      params: {
        chat_template_kwargs: {
          enable_thinking: false,
          force_nonempty_content: true,
        },
      },
    });
  });
});
