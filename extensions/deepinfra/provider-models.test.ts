import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isProviderApiKeyConfiguredMock = vi.hoisted(() => vi.fn<(p: unknown) => boolean>());
// mock-isolation: Discovery tests control credential availability without reading host auth state.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderApiKeyConfiguredAsync: async (params: unknown) =>
    isProviderApiKeyConfiguredMock(params),
}));

import { buildDeepInfraProvider } from "./api.js";
import { discoverDeepInfraModels, discoverDeepInfraSurfaces } from "./provider-models.js";
import { DEEPINFRA_MODEL_CATALOG } from "./provider-static-catalog.js";

const DEEPINFRA_MODELS_URL =
  "https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta";

beforeEach(() => {
  clearLiveCatalogCacheForTests();
  isProviderApiKeyConfiguredMock.mockReset();
  isProviderApiKeyConfiguredMock.mockReturnValue(false);
  vi.stubEnv("DEEPINFRA_API_KEY", "sk-test");
});

function makeAgentModelEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "openai/gpt-oss-120b",
    metadata: {
      context_length: 131072,
      max_tokens: 65536,
      pricing: {
        input_tokens: 3,
        output_tokens: 15,
        cache_read_tokens: 0.3,
      },
      tags: ["chat", "vlm", "vision", "reasoning_effort", "prompt_cache", "reasoning"],
    },
    ...overrides,
  };
}

const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const nativePrice = {
  type: "tokens",
  cents_per_input_token: 0.0002,
  cents_per_output_token: 0.001,
};
const modelResponse = (...data: unknown[]) => Response.json({ data });
const priceResponse = (id: string, pricing: Record<string, unknown> = nativePrice) =>
  Response.json([{ model_name: id, pricing }]);

function surfaceEntry(id: string, tags: string[], metadata: Record<string, unknown> = {}) {
  return makeAgentModelEntry({ id, metadata: { tags, ...metadata } });
}

function mockFetchPath(mockFetch: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function mockProjectionFetch(
  projection: () => Promise<Response> | Response,
  pricing = () => priceResponse("fixture/native-only"),
) {
  return mockFetchPath(
    vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "https://api.deepinfra.com/models/list") {
        return pricing();
      }
      expect(url).toBe(DEEPINFRA_MODELS_URL);
      return projection();
    }),
  );
}

function mockCatalogs(...catalogs: unknown[][]) {
  const projection = vi.fn<() => Response>();
  for (const rows of catalogs) {
    projection.mockReturnValueOnce(modelResponse(...rows));
  }
  return mockProjectionFetch(projection);
}

describe("DeepInfra pre-auth discovery", () => {
  it("stays offline with a blank environment key and no saved profile", async () => {
    const mockFetch = mockFetchPath(vi.fn());
    expect(await discoverDeepInfraSurfaces({ env: { DEEPINFRA_API_KEY: "   " } })).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("discovers with a saved profile when the environment has no key", async () => {
    isProviderApiKeyConfiguredMock.mockReturnValue(true);
    mockProjectionFetch(() => modelResponse(makeAgentModelEntry()));
    expect(
      await discoverDeepInfraSurfaces({ env: {}, agentDir: "/tmp/openclaw-agent" }),
    ).not.toBeNull();
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "deepinfra",
      agentDir: "/tmp/openclaw-agent",
    });
  });
});

describe("discoverDeepInfraModels", () => {
  it("preserves bundled reasoning and compat while keeping live model facts authoritative", async () => {
    const rows = [
      surfaceEntry("deepseek-ai/DeepSeek-V4-Pro", ["chat"], {
        context_length: 96000,
        max_tokens: 4096,
        pricing: { input_tokens: 4, output_tokens: 8, cache_read_tokens: 0.4 },
      }),
      surfaceEntry("moonshotai/Kimi-K2.6", ["chat", "vlm", "vision"], {
        context_length: 192000,
        max_tokens: 16384,
        pricing: { input_tokens: 0.2, output_tokens: 1.15 },
      }),
      surfaceEntry("deepseek-ai/DeepSeek-V3.2", ["chat", "reasoning"]),
      surfaceEntry("unlisted/no-reasoning", ["chat"]),
      surfaceEntry("unlisted/with-reasoning", ["chat", "reasoning_effort"]),
    ];
    mockProjectionFetch(() => modelResponse(...rows));
    DEEPINFRA_MODEL_CATALOG.push(DEEPINFRA_MODEL_CATALOG[0]!);

    try {
      const models = await discoverDeepInfraModels();

      expect(models.slice(0, rows.length)).toMatchObject([
        {
          id: "deepseek-ai/DeepSeek-V4-Pro",
          reasoning: true,
          input: ["text"],
          contextWindow: 96000,
          maxTokens: 4096,
          cost: emptyCost,
          compat: {
            codeMode: "capable",
            supportsUsageInStreaming: true,
            thinkingFormat: "deepseek",
          },
        },
        {
          id: "moonshotai/Kimi-K2.6",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 192000,
          maxTokens: 16384,
          cost: emptyCost,
        },
        { id: "deepseek-ai/DeepSeek-V3.2", reasoning: false },
        { id: "unlisted/no-reasoning", reasoning: false },
        { id: "unlisted/with-reasoning", reasoning: true },
      ]);
      expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
    } finally {
      DEEPINFRA_MODEL_CATALOG.pop();
    }
  });

  it("ignores untagged entries and prototype tags, and deduplicates tags and ids", async () => {
    mockProjectionFetch(() =>
      modelResponse(
        { id: "BAAI/bge-m3", object: "model", metadata: null },
        makeAgentModelEntry({
          id: "untagged/model",
          metadata: { context_length: 1, max_tokens: 1, pricing: {}, tags: [] },
        }),
        surfaceEntry("openai/gpt-oss-120b", [
          "chat",
          "constructor",
          "toString",
          "__proto__",
          "chat",
        ]),
        makeAgentModelEntry(),
      ),
    );

    const models = await discoverDeepInfraModels();
    expect(models.map((m) => m.id)).toEqual(["openai/gpt-oss-120b"]);
  });

  it("rejects malformed tags without caching partial metadata", async () => {
    const mockFetch = mockCatalogs(
      [makeAgentModelEntry(), { id: "broken/model", metadata: { tags: [42] } }],
      [makeAgentModelEntry({ id: "recovered/model" })],
    );
    await expect(discoverDeepInfraModels()).rejects.toThrow("metadata discovery unavailable");
    expect((await discoverDeepInfraModels()).map((model) => model.id)).toEqual(["recovered/model"]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retains and caches a successful empty catalog", async () => {
    const mockFetch = mockCatalogs([], [makeAgentModelEntry({ id: "recovered/model" })]);

    expect(await discoverDeepInfraModels()).toEqual([]);
    expect(await discoverDeepInfraModels()).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("discoverDeepInfraSurfaces (per-surface bucketing)", () => {
  it("drops malformed live token limits", async () => {
    mockCatalogs([surfaceEntry("bad/chat", ["chat"], { context_length: -1, max_tokens: 1.5 })]);

    const catalog = await discoverDeepInfraSurfaces();

    expect(catalog?.chat[0]).toMatchObject({ id: "bad/chat" });
    expect(catalog?.chat[0]?.contextWindow).toBeUndefined();
    expect(catalog?.chat[0]?.maxTokens).toBeUndefined();
  });
});

describe("DeepInfra native runtime prices", () => {
  it.each([
    { metadata: 503, pricing: 503 },
    { metadata: 503, pricing: 200 },
    { metadata: 200, pricing: 503 },
  ])("keeps the public builder advisory for $metadata/$pricing", async (scenario) => {
    mockFetchPath(
      vi.fn(async (url: string) => {
        const metadata = url === DEEPINFRA_MODELS_URL;
        const status = metadata ? scenario.metadata : scenario.pricing;
        if (status !== 200) {
          return new Response("unavailable", { status });
        }
        return metadata
          ? modelResponse(makeAgentModelEntry({ id: "fixture/public-model" }))
          : priceResponse("fixture/public-model");
      }),
    );
    const provider = await buildDeepInfraProvider({ hasApiKey: true });
    expect(provider.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(DEEPINFRA_MODEL_CATALOG.map((model) => model.id)),
    );
    if (scenario.metadata === 200) {
      expect(provider.models.find((model) => model.id === "fixture/public-model")?.cost).toEqual(
        emptyCost,
      );
    }
  });

  it("rejects malformed native pricing and recovers without refetching metadata", async () => {
    let nativeCalls = 0;
    const mockFetch = mockProjectionFetch(
      () => modelResponse(makeAgentModelEntry({ id: "fixture/recovered" })),
      () =>
        priceResponse("fixture/recovered", {
          ...nativePrice,
          cents_per_input_token: ++nativeCalls === 1 ? -1 : 0.0002,
        }),
    );
    await expect(discoverDeepInfraModels({ hasApiKey: true })).rejects.toThrow(
      "Native DeepInfra pricing is malformed or has no usable schedules",
    );
    const recovered = await discoverDeepInfraModels({ hasApiKey: true });
    expect(recovered[0]?.cost).toEqual({ input: 2, output: 10, cacheRead: 0, cacheWrite: 0 });
    expect(recovered.map((model) => model.id)).toEqual(["fixture/recovered"]);
    expect(await discoverDeepInfraModels({ hasApiKey: true })).toEqual(recovered);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("uses native DeepInfra discounts and omits qualified prices without changing metadata", async () => {
    const nativePricing = {
      ...nativePrice,
      rate_per_input_token_cached: 0.2,
      discount: 0.5,
      discount_ends_at: null,
    };
    const mockFetch = mockProjectionFetch(
      () =>
        modelResponse(
          ...["fixture/paid", "fixture/qualified", "fixture/absent"].map((id) =>
            makeAgentModelEntry({ id }),
          ),
        ),
      () =>
        Response.json([
          { model_name: "fixture/paid", pricing: nativePricing },
          {
            model_name: "fixture/qualified",
            pricing: { ...nativePricing, full: "Higher rates above a context threshold" },
          },
          { model_name: DEEPINFRA_MODEL_CATALOG[0]!.id, pricing: nativePricing },
        ]),
    );
    const models = await discoverDeepInfraModels({ hasApiKey: true });
    expect(models.slice(0, 3).map((model) => model.id)).toEqual([
      "fixture/paid",
      "fixture/qualified",
      "fixture/absent",
    ]);
    expect(models[0]).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 131072,
      maxTokens: 65536,
      cost: { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 0 },
    });
    for (const model of models) {
      expect(model.cost).toEqual(
        model.id === "fixture/paid" || model.id === DEEPINFRA_MODEL_CATALOG[0]!.id
          ? { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 0 }
          : emptyCost,
      );
    }
    expect(await discoverDeepInfraModels({ hasApiKey: true })).toEqual(models);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mockFetch.mock.calls) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
  });
});
