// Hybrid OpenCode Zen catalog unit tests (fixtures only; no network).
import {
  buildHybridModelDefinitions,
  mapModelsDevCost,
  parseModelsDevProviderSlice,
} from "openclaw/plugin-sdk/provider-catalog-hybrid-runtime";
import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpencodeZenHybridProviderConfig,
  clearOpencodeHybridCatalogStateForTests,
  resolveHybridDynamicModel,
  resolveOpencodeZenFamilyTransport,
} from "./hybrid-catalog.js";
import {
  buildOpencodeZenLiveProviderConfig,
  buildStaticOpencodeZenProviderConfig,
  resolveOpencodeZenModel,
  type OpencodeZenModelDefinition,
} from "./provider-catalog.js";

function staticHybridModels(): OpencodeZenModelDefinition[] {
  return buildStaticOpencodeZenProviderConfig().models as OpencodeZenModelDefinition[];
}

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
          // models.dev marks retired ids deprecated; hybrid must exclude them.
          status: "deprecated",
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
        "zen-hybrid-only": {
          id: "zen-hybrid-only",
          name: "Zen Hybrid Only",
          reasoning: true,
          modalities: { input: ["text"] },
          limit: { context: 200_000, output: 32_768 },
          cost: { input: 1, output: 2, cache_read: 0.1 },
        },
        // Stale upstream deprecation must not drop a static-seeded active model.
        "claude-opus-4-7": {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          status: "deprecated",
          reasoning: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 200_000, output: 65_536 },
          cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        },
      },
    },
  };
}

function gatewayFetchGuard(ids: string[]): LiveModelCatalogFetchGuard {
  return vi.fn(async (req) => {
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
    const staticModels = staticHybridModels();
    const modelsDev = parseModelsDevProviderSlice(modelsDevFixture(), "opencode");
    const hybrid = buildHybridModelDefinitions({
      gatewayIds: [
        "claude-opus-4-7",
        "claude-opus-5",
        "claude-opus-4-8",
        "unknown-skip",
        "gpt-5.6-sol",
      ],
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
    // models.dev-deprecated claude-opus-4-8 is excluded; unknown-skip has no
    // metadata and no static row.
    expect(hybrid.map((model) => model.id)).toEqual([
      "claude-opus-4-7",
      "claude-opus-5",
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
    // Hybrid transport routing matches the shipped Zen family rules.
    expect(hybrid.find((model) => model.id === "gpt-5.6-sol")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/v1",
    });
    expect(
      resolveOpencodeZenFamilyTransport(
        "grok-4.5",
        "https://opencode.ai/zen/v1",
        "https://opencode.ai/zen",
      ),
    ).toEqual({ api: "openai-responses", baseUrl: "https://opencode.ai/zen/v1" });
    expect(
      resolveOpencodeZenFamilyTransport(
        "gemini-3-pro",
        "https://opencode.ai/zen/v1",
        "https://opencode.ai/zen",
      ),
    ).toEqual({ api: "google-generative-ai", baseUrl: "https://opencode.ai/zen/v1" });
  });

  it("merges live gateway + models.dev and falls back offline to static", async () => {
    let failGateway = false;
    const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>(async (req) => {
      if (req.url.includes("models.dev")) {
        return {
          response: new Response(JSON.stringify(modelsDevFixture())),
          finalUrl: req.url,
          release: vi.fn(async () => undefined),
        };
      }
      if (failGateway) {
        throw new Error("network unavailable");
      }
      return {
        response: new Response(
          JSON.stringify({
            data: ["claude-opus-5", "claude-opus-4-8", "gpt-6-experimental"].map((id) => ({
              id,
              object: "model",
            })),
          }),
        ),
        finalUrl: req.url,
        release: vi.fn(async () => undefined),
      };
    });
    const live = await buildOpencodeZenLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-key",
      fetchGuard,
      fetchModelsDev: async () => modelsDevFixture(),
    });
    // models.dev marks claude-opus-4-8 deprecated even though the gateway still
    // lists it; only non-deprecated metadata rows may enter the live catalog.
    expect(live.models.map((model) => model.id)).toEqual(["claude-opus-5"]);
    expect(resolveOpencodeZenModel("claude-opus-5")).toMatchObject({
      id: "claude-opus-5",
      provider: "opencode",
    });

    clearLiveCatalogCacheForTests();
    clearOpencodeHybridCatalogStateForTests();
    failGateway = true;
    const offline = await buildOpencodeZenLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-key",
      fetchGuard,
      fetchModelsDev: async () => {
        throw new Error("models.dev offline");
      },
    });
    expect(offline.models.map((model) => model.id)).toContain("claude-opus-4-7");
  });

  it("single-flights hybrid catalog loads for the same discovery key", async () => {
    const fetchGuard = gatewayFetchGuard(["claude-opus-5"]);
    const fetchModelsDev = vi.fn(async () => modelsDevFixture());
    const args = {
      apiKey: "k",
      discoveryApiKey: "d",
      fetchGuard,
      fetchModelsDev,
      staticModels: staticHybridModels(),
      gatewayEndpoint: "https://opencode.ai/zen/v1/models",
      gatewayTimeoutMs: 5_000,
      openaiBaseUrl: "https://opencode.ai/zen/v1",
      anthropicBaseUrl: "https://opencode.ai/zen",
    };
    const first = await buildOpencodeZenHybridProviderConfig(args);
    const second = await buildOpencodeZenHybridProviderConfig(args);
    expect(fetchGuard).toHaveBeenCalledTimes(1);
    expect(fetchModelsDev).toHaveBeenCalledTimes(1);
    expect(first.models.map((model) => model.id)).toEqual(second.models.map((model) => model.id));
  });

  it("resolveHybridDynamicModel falls back to static before hybrid warm", () => {
    const staticModels = staticHybridModels();
    expect(resolveHybridDynamicModel("claude-opus-4-7", staticModels)?.id).toBe("claude-opus-4-7");
    expect(resolveHybridDynamicModel("gpt-6-experimental", staticModels)).toBeUndefined();
  });

  it("does not sticky-cache static seed when gateway IDs are empty and retries fetch", async () => {
    let gatewayIds: string[] = [];
    const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>(async (req) => {
      if (req.url.includes("models.dev")) {
        return {
          response: new Response(JSON.stringify(modelsDevFixture())),
          finalUrl: req.url,
          release: vi.fn(async () => undefined),
        };
      }
      return {
        response: new Response(
          JSON.stringify({ data: gatewayIds.map((id) => ({ id, object: "model" })) }),
        ),
        finalUrl: req.url,
        release: vi.fn(async () => undefined),
      };
    });
    const args = {
      apiKey: "k",
      discoveryApiKey: "d",
      fetchGuard,
      fetchModelsDev: async () => modelsDevFixture(),
      staticModels: staticHybridModels(),
      gatewayEndpoint: "https://opencode.ai/zen/v1/models",
      gatewayTimeoutMs: 5_000,
      openaiBaseUrl: "https://opencode.ai/zen/v1",
      anthropicBaseUrl: "https://opencode.ai/zen",
    };

    const empty = await buildOpencodeZenHybridProviderConfig(args);
    expect(empty.models.map((model) => model.id)).toContain("claude-opus-4-7");
    const gatewayCallsAfterEmpty = fetchGuard.mock.calls.filter(
      (call) => !call[0].url.includes("models.dev"),
    ).length;
    expect(gatewayCallsAfterEmpty).toBe(1);

    gatewayIds = ["claude-opus-5"];
    const recovered = await buildOpencodeZenHybridProviderConfig(args);
    const gatewayCallsAfterRecover = fetchGuard.mock.calls.filter(
      (call) => !call[0].url.includes("models.dev"),
    ).length;
    expect(gatewayCallsAfterRecover).toBe(2);
    expect(recovered.models.map((model) => model.id)).toEqual(["claude-opus-5"]);
  });

  it("refreshes hybrid merge after short hybrid success TTL while models.dev stays sticky", async () => {
    let now = 1_000;
    let gatewayIds = ["claude-opus-4-7"];
    const fetchModelsDev = vi.fn(async () => modelsDevFixture());
    const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>(async (req) => {
      if (req.url.includes("models.dev")) {
        return {
          response: new Response(JSON.stringify(modelsDevFixture())),
          finalUrl: req.url,
          release: vi.fn(async () => undefined),
        };
      }
      return {
        response: new Response(
          JSON.stringify({ data: gatewayIds.map((id) => ({ id, object: "model" })) }),
        ),
        finalUrl: req.url,
        release: vi.fn(async () => undefined),
      };
    });
    const args = {
      apiKey: "k",
      discoveryApiKey: "ttl-key",
      fetchGuard,
      fetchModelsDev,
      staticModels: staticHybridModels(),
      gatewayEndpoint: "https://opencode.ai/zen/v1/models",
      gatewayTimeoutMs: 5_000,
      openaiBaseUrl: "https://opencode.ai/zen/v1",
      anthropicBaseUrl: "https://opencode.ai/zen",
      now: () => now,
      gatewayIdsTtlMs: 50,
      hybridSuccessTtlMs: 50,
    };

    const first = await buildOpencodeZenHybridProviderConfig(args);
    expect(first.models.map((model) => model.id)).toEqual(["claude-opus-4-7"]);
    expect(fetchModelsDev).toHaveBeenCalledTimes(1);

    gatewayIds = ["claude-opus-5"];
    now = 1_020;
    const stillCached = await buildOpencodeZenHybridProviderConfig(args);
    expect(stillCached.models.map((model) => model.id)).toEqual(["claude-opus-4-7"]);

    now = 1_060;
    const refreshed = await buildOpencodeZenHybridProviderConfig(args);
    expect(refreshed.models.map((model) => model.id)).toEqual(["claude-opus-5"]);
    expect(fetchModelsDev).toHaveBeenCalledTimes(1);
  });

  it("keeps resolveHybridDynamicModel scoped to the last successful auth catalog", async () => {
    const staticModels = staticHybridModels();
    const fetchGuardA = gatewayFetchGuard(["zen-hybrid-only"]);
    await buildOpencodeZenHybridProviderConfig({
      apiKey: "runtime-a",
      discoveryApiKey: "discovery-a",
      fetchGuard: fetchGuardA,
      fetchModelsDev: async () => modelsDevFixture(),
      staticModels,
      gatewayEndpoint: "https://opencode.ai/zen/v1/models",
      gatewayTimeoutMs: 5_000,
      openaiBaseUrl: "https://opencode.ai/zen/v1",
      anthropicBaseUrl: "https://opencode.ai/zen",
    });
    expect(resolveHybridDynamicModel("zen-hybrid-only", staticModels)?.id).toBe("zen-hybrid-only");

    const fetchGuardB = gatewayFetchGuard(["claude-opus-5"]);
    await buildOpencodeZenHybridProviderConfig({
      apiKey: "runtime-b",
      discoveryApiKey: "discovery-b",
      fetchGuard: fetchGuardB,
      fetchModelsDev: async () => modelsDevFixture(),
      staticModels,
      gatewayEndpoint: "https://opencode.ai/zen/v1/models",
      gatewayTimeoutMs: 5_000,
      openaiBaseUrl: "https://opencode.ai/zen/v1",
      anthropicBaseUrl: "https://opencode.ai/zen",
    });
    expect(resolveHybridDynamicModel("claude-opus-5", staticModels)?.id).toBe("claude-opus-5");
    // Last successful catalog wins for unscoped resolve (catalog path sets last auth key).
    expect(resolveHybridDynamicModel("zen-hybrid-only", staticModels)).toBeUndefined();
  });

  it("single-flights parallel hybrid loads for the same discovery key", async () => {
    const fetchGuard = gatewayFetchGuard(["claude-opus-5"]);
    const fetchModelsDev = vi.fn(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      return modelsDevFixture();
    });
    const args = {
      apiKey: "k",
      discoveryApiKey: "parallel",
      fetchGuard,
      fetchModelsDev,
      staticModels: staticHybridModels(),
      gatewayEndpoint: "https://opencode.ai/zen/v1/models",
      gatewayTimeoutMs: 5_000,
      openaiBaseUrl: "https://opencode.ai/zen/v1",
      anthropicBaseUrl: "https://opencode.ai/zen",
    };
    const [a, b] = await Promise.all([
      buildOpencodeZenHybridProviderConfig(args),
      buildOpencodeZenHybridProviderConfig(args),
    ]);
    expect(fetchModelsDev).toHaveBeenCalledTimes(1);
    expect(a.models.map((model) => model.id)).toEqual(b.models.map((model) => model.id));
  });
});
