// Hybrid OpenCode Zen catalog unit tests (fixtures only; no network).
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHybridModelDefinitions,
  buildOpencodeZenHybridProviderConfig,
  clearOpencodeHybridCatalogStateForTests,
  mapModelsDevCost,
  parseModelsDevProviderSlice,
  resolveHybridDynamicModel,
  resolveOpencodeZenFamilyTransport,
} from "./hybrid-catalog.js";
import {
  buildOpencodeZenLiveProviderConfig,
  buildStaticOpencodeZenProviderConfig,
  resolveOpencodeZenModel,
} from "./provider-catalog.js";

function modelsDevFixture() {
  return {
    opencode: {
      models: {
        "claude-opus-5": {
          id: "claude-opus-5",
          name: "Claude Opus 5",
          reasoning: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 1_000_000, output: 128_000 },
          provider: { npm: "@ai-sdk/anthropic" },
          cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        },
        "claude-opus-4-8": {
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          reasoning: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 200_000, output: 65_536 },
          provider: { npm: "@ai-sdk/anthropic" },
          cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        },
        "gpt-5.6-sol": {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          reasoning: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 1_050_000, output: 128_000 },
          provider: { npm: "@ai-sdk/openai" },
          cost: {
            input: 5,
            output: 30,
            cache_read: 0.5,
            cache_write: 6.25,
            tiers: [
              {
                input: 10,
                output: 45,
                cache_read: 1,
                cache_write: 12.5,
                tier: { type: "context", size: 272_000 },
              },
            ],
          },
        },
      },
    },
  };
}

function gatewayFetchGuard(ids: string[]) {
  return vi.fn(async (req: { url: string }) => {
    if (req.url.includes("models.dev")) {
      return {
        response: new Response(JSON.stringify(modelsDevFixture())),
        finalUrl: req.url,
        release: vi.fn(async () => undefined),
      };
    }
    return {
      response: new Response(JSON.stringify({ data: ids.map((id) => ({ id, object: "model" })) })),
      finalUrl: req.url,
      release: vi.fn(async () => undefined),
    };
  });
}

describe("opencode hybrid catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    clearOpencodeHybridCatalogStateForTests();
  });

  it("maps models.dev cost tiers into OpenClaw tieredPricing", () => {
    const cost = mapModelsDevCost({
      input: 5,
      output: 30,
      cache_read: 0.5,
      cache_write: 6.25,
      tiers: [
        {
          input: 10,
          output: 45,
          cache_read: 1,
          cache_write: 12.5,
          tier: { type: "context", size: 272_000 },
        },
      ],
    });
    expect(cost).toEqual({
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      tieredPricing: [
        { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25, range: [0, 272_000] },
        { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5, range: [272_000] },
      ],
    });
  });

  it("parses models.dev provider slices by key", () => {
    const slice = parseModelsDevProviderSlice(modelsDevFixture(), "opencode");
    expect(slice.has("claude-opus-5")).toBe(true);
    expect(slice.has("gpt-5.6-sol")).toBe(true);
    expect(parseModelsDevProviderSlice(modelsDevFixture(), "missing").size).toBe(0);
  });

  it("builds hybrid rows from gateway ids + models.dev + static fallback", () => {
    const staticModels = buildStaticOpencodeZenProviderConfig().models;
    const modelsDev = parseModelsDevProviderSlice(modelsDevFixture(), "opencode");
    const hybrid = buildHybridModelDefinitions({
      gatewayIds: ["claude-opus-5", "claude-opus-4-8", "unknown-skip", "gpt-5.6-sol"],
      modelsDev,
      staticModels,
      providerId: "opencode",
      resolveTransport: (modelId) =>
        resolveOpencodeZenFamilyTransport(
          modelId,
          "https://opencode.ai/zen/v1",
          "https://opencode.ai/zen",
        ),
      applyPolicyOverlay: (model) => model,
    });
    expect(hybrid.map((model) => model.id)).toEqual([
      "claude-opus-5",
      "claude-opus-4-8",
      "gpt-5.6-sol",
    ]);
    expect(hybrid.find((model) => model.id === "claude-opus-5")).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
      provider: "opencode",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    });
  });

  it("merges live gateway + models.dev and falls back offline to static", async () => {
    const fetchGuard = gatewayFetchGuard([
      "claude-opus-5",
      "claude-opus-4-8",
      "gpt-6-experimental",
    ]);
    const live = await buildOpencodeZenLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-key",
      fetchGuard,
      fetchModelsDev: async () => modelsDevFixture(),
    });
    expect(live.models.map((model) => model.id)).toEqual(["claude-opus-5", "claude-opus-4-8"]);
    expect(resolveOpencodeZenModel("claude-opus-5")).toMatchObject({
      id: "claude-opus-5",
      provider: "opencode",
    });

    clearLiveCatalogCacheForTests();
    clearOpencodeHybridCatalogStateForTests();
    fetchGuard.mockRejectedValueOnce(new Error("network unavailable"));
    const offline = await buildOpencodeZenLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-key",
      fetchGuard,
      fetchModelsDev: async () => {
        throw new Error("models.dev offline");
      },
    });
    expect(offline.models.map((model) => model.id)).toContain("claude-opus-4-8");
  });

  it("single-flights hybrid catalog loads for the same discovery key", async () => {
    const fetchGuard = gatewayFetchGuard(["claude-opus-4-8"]);
    const fetchModelsDev = vi.fn(async () => modelsDevFixture());
    const args = {
      apiKey: "k",
      discoveryApiKey: "d",
      fetchGuard,
      fetchModelsDev,
      staticModels: buildStaticOpencodeZenProviderConfig().models,
      gatewayEndpoint: "https://opencode.ai/zen/v1/models",
      gatewayTimeoutMs: 5_000,
      openaiBaseUrl: "https://opencode.ai/zen/v1",
      anthropicBaseUrl: "https://opencode.ai/zen",
    } as const;
    const first = await buildOpencodeZenHybridProviderConfig(args);
    const second = await buildOpencodeZenHybridProviderConfig(args);
    expect(fetchGuard).toHaveBeenCalledTimes(1);
    expect(fetchModelsDev).toHaveBeenCalledTimes(1);
    expect(first.models.map((model) => model.id)).toEqual(second.models.map((model) => model.id));
  });

  it("resolveHybridDynamicModel falls back to static before hybrid warm", () => {
    const staticModels = buildStaticOpencodeZenProviderConfig().models;
    expect(resolveHybridDynamicModel("claude-opus-4-8", staticModels)?.id).toBe("claude-opus-4-8");
    expect(resolveHybridDynamicModel("claude-opus-5", staticModels)).toBeUndefined();
  });
});
