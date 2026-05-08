import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLiveNvidiaProvider,
  buildNvidiaProvider,
  clearNvidiaFeaturedModelCacheForTests,
} from "./provider-catalog.js";

afterEach(() => {
  clearNvidiaFeaturedModelCacheForTests();
  vi.unstubAllGlobals();
});

describe("nvidia provider catalog", () => {
  it("builds the bundled NVIDIA provider defaults", () => {
    const provider = buildNvidiaProvider();

    expect(provider.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.apiKey).toBe("NVIDIA_API_KEY");
    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
    expect(provider.models.filter((model) => model.compat?.requiresStringContent !== true)).toEqual(
      [],
    );
  });

  it("promotes ranked models from NVIDIA's featured catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
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
        }),
      ),
    );

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "z-ai/glm-5.1",
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
    expect(provider.models[0]).toMatchObject({
      name: "GLM 5.1",
      contextWindow: 202752,
      maxTokens: 8192,
      compat: { requiresStringContent: true },
    });
  });

  it("falls back to the bundled catalog when the featured catalog is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
  });

  it("caches the featured catalog for repeated provider builds", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        "featured-models": [
          {
            model: "minimaxai/minimax-m2.7",
            "model-name": "Minimax M2.7",
            context: 196608,
            "max-output": 8192,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await buildLiveNvidiaProvider();
    await buildLiveNvidiaProvider();

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
