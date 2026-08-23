import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
// Hybrid OpenCode Go catalog unit tests (fixtures only; no network).
import {
  buildHybridModelDefinitions,
  parseModelsDevProviderSlice,
} from "openclaw/plugin-sdk/provider-catalog-hybrid-runtime";
import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOpencodeGoPolicyOverlay,
  buildOpencodeGoHybridProviderConfig,
  resolveOpencodeGoFamilyTransport,
} from "./hybrid-catalog.js";
import plugin from "./index.js";
import {
  buildOpencodeGoLiveProviderConfig,
  buildStaticOpencodeGoProviderConfig,
  resolveOpencodeGoModel,
  type OpencodeGoModelDefinition,
} from "./provider-catalog.js";

// Credential resolution is mocked per profile id so scoped-resolution tests run
// offline: profile "opencode-go:a" gets key-a, "opencode-go:b" gets key-b.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: vi.fn(async (params: { profileId?: string }) => ({
    apiKey: params.profileId?.endsWith(":a")
      ? "key-a"
      : params.profileId?.endsWith(":b")
        ? "key-b"
        : undefined,
    source: "test",
    mode: "api-key",
  })),
}));

function staticHybridModels(): OpencodeGoModelDefinition[] {
  return buildStaticOpencodeGoProviderConfig().models as OpencodeGoModelDefinition[];
}

function modelsDevFixture() {
  return {
    "opencode-go": {
      models: {
        "kimi-k3": {
          id: "kimi-k3",
          name: "Kimi K3",
          reasoning: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 1_048_576, output: 131_072 },
          cost: { input: 3, output: 15, cache_read: 0.3 },
        },
        "minimax-m3": {
          id: "minimax-m3",
          name: "MiniMax-M3",
          reasoning: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 1_000_000, output: 131_072 },
          provider: { npm: "@ai-sdk/anthropic" },
          cost: {
            input: 0.3,
            output: 1.2,
            cache_read: 0.06,
            tiers: [
              {
                input: 0.6,
                output: 2.4,
                cache_read: 0.12,
                tier: { type: "context", size: 512_000 },
              },
            ],
          },
        },
        "deepseek-v4-pro": {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          reasoning: true,
          modalities: { input: ["text"] },
          limit: { context: 1_000_000, output: 384_000 },
          cost: { input: 0.435, output: 0.87, cache_read: 0.0435 },
        },
        "glm-5": {
          id: "glm-5",
          name: "GLM-5",
          reasoning: true,
          // models.dev marks retired ids deprecated; hybrid must exclude them.
          status: "deprecated",
          modalities: { input: ["text"] },
          limit: { context: 202_752, output: 32_768 },
          cost: { input: 1, output: 3.2, cache_read: 0.2 },
        },
        "gpt-6-go": {
          id: "gpt-6-go",
          name: "GPT-6 Go",
          reasoning: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 400_000, output: 128_000 },
          cost: { input: 2, output: 6, cache_read: 0.3 },
        },
        "go-hybrid-only": {
          id: "go-hybrid-only",
          name: "Go Hybrid Only",
          reasoning: true,
          modalities: { input: ["text"] },
          limit: { context: 262_144, output: 32_768 },
          cost: { input: 1, output: 2, cache_read: 0.1 },
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

describe("opencode-go hybrid catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("routes Go model families to shipped transports without invented overlays", () => {
    const go = (modelId: string) =>
      resolveOpencodeGoFamilyTransport(
        modelId,
        "https://opencode.ai/zen/go/v1",
        "https://opencode.ai/zen/go",
      );
    expect(go("minimax-m3")).toEqual({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    });
    expect(go("qwen3.5-plus")).toEqual({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    });
    expect(go("gpt-6-go")).toEqual({
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
    expect(go("deepseek-v4-pro")).toEqual({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
    // DeepSeek rows keep the static seed's shape: efforts, no thinkingLevelMap.
    const deepseek = applyOpencodeGoPolicyOverlay(
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek",
        api: "openai-completions",
        provider: "opencode-go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1,
        maxTokens: 1,
      },
      undefined,
    );
    expect(deepseek.thinkingLevelMap).toBeUndefined();
    // Shipped qwen policy: rows without effort enums speak the qwen format.
    const qwen = applyOpencodeGoPolicyOverlay(
      {
        id: "qwen3.5-plus",
        name: "Qwen",
        api: "anthropic-messages",
        provider: "opencode-go",
        baseUrl: "https://opencode.ai/zen/go",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1,
        maxTokens: 1,
      },
      undefined,
    );
    expect(qwen.compat?.thinkingFormat).toBe("qwen");
  });

  it("skips deprecated MiMo aliases and includes models.dev-only gateway ids", () => {
    const staticModels = staticHybridModels();
    const modelsDev = parseModelsDevProviderSlice(modelsDevFixture(), "opencode-go");
    const hybrid = buildHybridModelDefinitions({
      gatewayIds: ["mimo-v2-omni", "mimo-v2-pro", "kimi-k3", "minimax-m3"],
      modelsDev,
      staticModels,
      providerId: "opencode-go",
      resolveTransport: (modelId) =>
        resolveOpencodeGoFamilyTransport(
          modelId,
          "https://opencode.ai/zen/go/v1",
          "https://opencode.ai/zen/go",
        ),
      applyPolicyOverlay: applyOpencodeGoPolicyOverlay,
      skipGatewayIds: new Set(["mimo-v2-omni", "mimo-v2-pro"]),
    });
    expect(hybrid.map((model) => model.id)).toEqual(["kimi-k3", "minimax-m3"]);
    expect(hybrid.find((model) => model.id === "kimi-k3")).toMatchObject({
      provider: "opencode-go",
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    });
  });

  it("excludes models.dev-deprecated gateway ids even with metadata present", () => {
    const hybrid = buildHybridModelDefinitions({
      gatewayIds: ["glm-5", "kimi-k3"],
      modelsDev: parseModelsDevProviderSlice(modelsDevFixture(), "opencode-go"),
      staticModels: staticHybridModels(),
      providerId: "opencode-go",
      resolveTransport: (modelId) =>
        resolveOpencodeGoFamilyTransport(
          modelId,
          "https://opencode.ai/zen/go/v1",
          "https://opencode.ai/zen/go",
        ),
      applyPolicyOverlay: applyOpencodeGoPolicyOverlay,
    });
    expect(hybrid.map((model) => model.id)).toEqual(["kimi-k3"]);
  });

  it("builds live hybrid catalog and resolves dynamic models from hybrid map", async () => {
    const fetchGuard = gatewayFetchGuard([
      "kimi-k3",
      "minimax-m3",
      "mimo-v2-omni",
      "deepseek-v4-pro",
      "gpt-6-go",
    ]);
    const live = await buildOpencodeGoLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-key",
      fetchGuard,
      fetchModelsDev: async () => modelsDevFixture(),
    });
    expect(live.models.map((model) => model.id)).toEqual([
      "kimi-k3",
      "minimax-m3",
      "deepseek-v4-pro",
      "gpt-6-go",
    ]);
    expect(live.models.find((model) => model.id === "deepseek-v4-pro")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      cost: { input: 0.435, output: 0.87, cacheRead: 0.0435, cacheWrite: 0 },
    });
    expect(
      live.models.find((model) => model.id === "deepseek-v4-pro")?.thinkingLevelMap,
    ).toBeUndefined();
    expect(live.models.find((model) => model.id === "gpt-6-go")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
    expect(resolveOpencodeGoModel("kimi-k3")).toMatchObject({
      id: "kimi-k3",
      provider: "opencode-go",
    });
  });

  it("falls back to full static seed when live hybrid fails", async () => {
    const fetchGuard = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const offline = await buildOpencodeGoLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-key",
      fetchGuard,
      fetchModelsDev: async () => {
        throw new Error("models.dev offline");
      },
    });
    expect(offline.models.map((model) => model.id)).toContain("deepseek-v4-pro");
    expect(offline.models.map((model) => model.id)).toContain("minimax-m3");
    expect(offline.models.map((model) => model.id)).not.toContain("mimo-v2-omni");
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
      discoveryApiKey: "go-empty",
      fetchGuard,
      fetchModelsDev: async () => modelsDevFixture(),
      staticModels: staticHybridModels(),
      gatewayEndpoint: "https://opencode.ai/zen/go/v1/models",
      gatewayTimeoutMs: 5_000,
      openaiBaseUrl: "https://opencode.ai/zen/go/v1",
      anthropicBaseUrl: "https://opencode.ai/zen/go",
    };

    const empty = await buildOpencodeGoHybridProviderConfig(args);
    expect(empty.models.map((model) => model.id)).toContain("deepseek-v4-pro");

    gatewayIds = ["kimi-k3"];
    const recovered = await buildOpencodeGoHybridProviderConfig(args);
    expect(recovered.models.map((model) => model.id)).toEqual(["kimi-k3"]);
    const gatewayCalls = fetchGuard.mock.calls.filter(
      (call) => !call[0].url.includes("models.dev"),
    ).length;
    expect(gatewayCalls).toBe(2);
  });

  it("scopes prepared hybrid maps to the resolving profile", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("models.dev")) {
        return new Response(JSON.stringify(modelsDevFixture()));
      }
      const headers = new Headers(init?.headers);
      const key = (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const ids = key === "key-a" ? ["go-hybrid-only"] : ["minimax-m3"];
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id, object: "model" })) }));
    });
    try {
      const provider = await registerSingleProviderPlugin(plugin);
      const sharedRegistry = {};
      const prepare = (modelId: string, authProfileId: string) =>
        provider.prepareDynamicModel?.({
          modelRegistry: sharedRegistry,
          modelId,
          authProfileId,
          authProfileMode: "api-key",
        } as never);
      const resolve = (modelId: string, authProfileId: string) =>
        provider.resolveDynamicModel?.({
          modelRegistry: sharedRegistry,
          modelId,
          authProfileId,
          authProfileMode: "api-key",
        } as never);

      await prepare("go-hybrid-only", "opencode-go:a");
      // Profile B's catalog load on the SAME registry must not displace
      // profile A's scoped map.
      await prepare("minimax-m3", "opencode-go:b");

      expect(resolve("go-hybrid-only", "opencode-go:a")).toMatchObject({
        id: "go-hybrid-only",
        provider: "opencode-go",
      });
      expect(resolve("go-hybrid-only", "opencode-go:b")).toBeUndefined();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
