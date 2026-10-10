import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isProviderApiKeyConfiguredMock = vi.hoisted(() => vi.fn<(p: unknown) => boolean>());
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
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
});

function makeAgentModelEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "openai/gpt-oss-120b",
    object: "model",
    owned_by: "deepinfra",
    metadata: {
      description: "gpt-oss-120b",
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

function surfaceEntry(id: string, tags: string[], metadata: Record<string, unknown> = {}) {
  return makeAgentModelEntry({ id, metadata: { tags, ...metadata } });
}

async function withFetchPathTest(
  mockFetch: ReturnType<typeof vi.fn>,
  envOverrides: Record<string, string | undefined>,
  runAssertions: () => Promise<void>,
) {
  for (const [key, value] of Object.entries(envOverrides)) {
    vi.stubEnv(key, value);
  }
  vi.stubGlobal("fetch", mockFetch);
  try {
    await runAssertions();
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
});

function mockProjectionFetch(projection: () => Promise<Response> | Response) {
  return vi.fn(async (url: string) => {
    if (url === "https://api.deepinfra.com/models/list") {
      return Response.json([
        {
          model_name: "fixture/native-only",
          pricing: { type: "tokens", cents_per_input_token: 0.0002, cents_per_output_token: 0.001 },
        },
      ]);
    }
    expect(url).toBe(DEEPINFRA_MODELS_URL);
    return projection();
  });
}

describe("DeepInfra pre-auth discovery", () => {
  it("stays offline with a blank environment key and no saved profile", async () => {
    const mockFetch = vi.fn();
    await withFetchPathTest(mockFetch, {}, async () => {
      expect((await discoverDeepInfraSurfaces({ env: { DEEPINFRA_API_KEY: "   " } })).live).toBe(
        false,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  it("discovers with a saved profile when the environment has no key", async () => {
    isProviderApiKeyConfiguredMock.mockReturnValue(true);
    const mockFetch = mockProjectionFetch(() => Response.json({ data: [makeAgentModelEntry()] }));
    await withFetchPathTest(mockFetch, {}, async () => {
      expect(
        (await discoverDeepInfraSurfaces({ env: {}, agentDir: "/tmp/openclaw-agent" })).live,
      ).toBe(true);
    });
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
      surfaceEntry("stepfun-ai/Step-3.7-Flash", ["chat", "vlm", "vision"], {
        context_length: 192000,
        max_tokens: 16384,
        pricing: { input_tokens: 0.2, output_tokens: 1.15 },
      }),
      surfaceEntry("deepseek-ai/DeepSeek-V3.2", ["chat", "reasoning"]),
      surfaceEntry("unlisted/no-reasoning", ["chat"]),
      surfaceEntry("unlisted/with-reasoning", ["chat", "reasoning_effort"]),
    ];
    const mockFetch = mockProjectionFetch(vi.fn().mockResolvedValue(Response.json({ data: rows })));
    DEEPINFRA_MODEL_CATALOG.push(DEEPINFRA_MODEL_CATALOG[0]!);

    try {
      await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
        const models = await discoverDeepInfraModels();

        expect(models.slice(0, rows.length)).toMatchObject([
          {
            id: "deepseek-ai/DeepSeek-V4-Pro",
            reasoning: true,
            input: ["text"],
            contextWindow: 96000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: {
              codeMode: "capable",
              supportsUsageInStreaming: true,
              thinkingFormat: "deepseek",
            },
          },
          {
            id: "stepfun-ai/Step-3.7-Flash",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 192000,
            maxTokens: 16384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          { id: "deepseek-ai/DeepSeek-V3.2", reasoning: false },
          { id: "unlisted/no-reasoning", reasoning: false },
          { id: "unlisted/with-reasoning", reasoning: true },
        ]);
        expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
      });
    } finally {
      DEEPINFRA_MODEL_CATALOG.pop();
    }
  });

  it("ignores untagged entries and prototype tags, and deduplicates tags and ids", async () => {
    const mockFetch = mockProjectionFetch(
      vi.fn().mockResolvedValue(
        Response.json({
          data: [
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
          ],
        }),
      ),
    );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.map((m) => m.id)).toEqual(["openai/gpt-oss-120b"]);
    });
  });

  it("rejects malformed tags without caching partial metadata", async () => {
    const mockFetch = mockProjectionFetch(
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            data: [makeAgentModelEntry(), { id: "broken/model", metadata: { tags: [42] } }],
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ data: [makeAgentModelEntry({ id: "recovered/model" })] }),
        ),
    );
    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      await expect(discoverDeepInfraModels()).rejects.toThrow("metadata discovery unavailable");
      expect((await discoverDeepInfraModels()).map((model) => model.id)).toEqual([
        "recovered/model",
      ]);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  it("retains and caches a successful empty catalog", async () => {
    const mockFetch = mockProjectionFetch(
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ data: [] }))
        .mockResolvedValueOnce(
          Response.json({ data: [makeAgentModelEntry({ id: "recovered/model" })] }),
        ),
    );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      expect(await discoverDeepInfraModels()).toEqual([]);
      expect(await discoverDeepInfraModels()).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe("discoverDeepInfraSurfaces (per-surface bucketing)", () => {
  it("drops malformed live numeric metadata", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          surfaceEntry("bad/chat", ["chat"], { context_length: -1, max_tokens: 1.5 }),
          surfaceEntry("bad/image", ["image-gen"], {
            default_width: Number.POSITIVE_INFINITY,
            default_height: 1024.5,
            default_iterations: 0,
          }),
        ],
      }),
    );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const catalog = await discoverDeepInfraSurfaces();

      expect(catalog.chat[0]).toMatchObject({ id: "bad/chat" });
      expect(catalog.chat[0]?.contextWindow).toBeUndefined();
      expect(catalog.chat[0]?.maxTokens).toBeUndefined();
      expect(catalog.imageGen[0]).toMatchObject({ id: "bad/image" });
      expect(catalog.imageGen[0]?.defaultWidth).toBeUndefined();
      expect(catalog.imageGen[0]?.defaultHeight).toBeUndefined();
      expect(catalog.imageGen[0]?.defaultIterations).toBeUndefined();
    });
  });
});

describe("DeepInfra native runtime prices", () => {
  it.each([
    { metadata: 503, pricing: 503 },
    { metadata: 503, pricing: 200 },
    { metadata: 200, pricing: 503 },
  ])("keeps the public builder advisory for $metadata/$pricing", async (scenario) => {
    const mockFetch = vi.fn(async (url: string) => {
      const metadata = url === DEEPINFRA_MODELS_URL;
      const status = metadata ? scenario.metadata : scenario.pricing;
      if (status !== 200) {
        return new Response("unavailable", { status });
      }
      return Response.json(
        metadata
          ? { data: [makeAgentModelEntry({ id: "fixture/public-model" })] }
          : [
              {
                model_name: "fixture/public-model",
                pricing: {
                  type: "tokens",
                  cents_per_input_token: 0.0002,
                  cents_per_output_token: 0.001,
                },
              },
            ],
      );
    });
    await withFetchPathTest(mockFetch, {}, async () => {
      const provider = await buildDeepInfraProvider({ hasApiKey: true });
      expect(provider.models.map((model) => model.id)).toEqual(
        expect.arrayContaining(DEEPINFRA_MODEL_CATALOG.map((model) => model.id)),
      );
      if (scenario.metadata === 200) {
        expect(provider.models.find((model) => model.id === "fixture/public-model")?.cost).toEqual({
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        });
      }
    });
  });

  it("rejects malformed native pricing and recovers without refetching metadata", async () => {
    let nativeCalls = 0;
    const mockFetch = vi.fn(async (url: string) => {
      if (url === DEEPINFRA_MODELS_URL) {
        return Response.json({ data: [makeAgentModelEntry({ id: "fixture/recovered" })] });
      }
      expect(url).toBe("https://api.deepinfra.com/models/list");
      return Response.json([
        {
          model_name: "fixture/recovered",
          pricing: {
            type: "tokens",
            cents_per_input_token: ++nativeCalls === 1 ? -1 : 0.0002,
            cents_per_output_token: 0.001,
          },
        },
      ]);
    });
    await withFetchPathTest(mockFetch, {}, async () => {
      await expect(discoverDeepInfraModels({ hasApiKey: true })).rejects.toThrow(
        "Native DeepInfra pricing is malformed or has no usable schedules",
      );
      const recovered = await discoverDeepInfraModels({ hasApiKey: true });
      expect(recovered[0]?.cost).toEqual({ input: 2, output: 10, cacheRead: 0, cacheWrite: 0 });
      expect(recovered.map((model) => model.id)).toEqual(["fixture/recovered"]);
      expect(await discoverDeepInfraModels({ hasApiKey: true })).toEqual(recovered);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  it("uses native DeepInfra discounts and omits qualified prices without changing metadata", async () => {
    const nativePricing = {
      type: "tokens",
      cents_per_input_token: 0.0002,
      cents_per_output_token: 0.001,
      rate_per_input_token_cached: 0.2,
      discount: 0.5,
      discount_ends_at: null,
    };
    const mockFetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === DEEPINFRA_MODELS_URL) {
        return Response.json({
          data: ["fixture/paid", "fixture/qualified", "fixture/absent"].map((id) =>
            makeAgentModelEntry({ id }),
          ),
        });
      }
      expect(url).toBe("https://api.deepinfra.com/models/list");
      return Response.json([
        { model_name: "fixture/paid", pricing: nativePricing },
        {
          model_name: "fixture/qualified",
          pricing: { ...nativePricing, full: "Higher rates above a context threshold" },
        },
        { model_name: DEEPINFRA_MODEL_CATALOG[0]!.id, pricing: nativePricing },
      ]);
    });
    await withFetchPathTest(mockFetch, {}, async () => {
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
            : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        );
      }
      expect(await discoverDeepInfraModels({ hasApiKey: true })).toEqual(models);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      for (const [, init] of mockFetch.mock.calls) {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
      }
    });
  });
});
