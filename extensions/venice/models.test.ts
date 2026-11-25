import {
  buildOpenAICompatibleLiveModelProviderConfig,
  clearLiveCatalogCacheForTests,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VENICE_BASE_URL, VENICE_MODEL_CATALOG, VENICE_MODEL_DISCOVERY_OPTIONS } from "./models.js";

type ModelSpecOverride = {
  id: string;
  availableContextTokens?: number;
  maxCompletionTokens?: number;
  capabilities?: {
    supportsFunctionCalling?: boolean;
  };
  includeModelSpec?: boolean;
  pricing?: unknown;
};

async function discoverVeniceModels(rows: ModelSpecOverride[]) {
  const data = rows.map(({ id, includeModelSpec, ...spec }) =>
    includeModelSpec === false ? { id } : { id, model_spec: { name: id, ...spec } },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data })),
  );
  const provider = await buildOpenAICompatibleLiveModelProviderConfig({
    providerId: "venice",
    providerConfig: {
      baseUrl: VENICE_BASE_URL,
      api: "openai-completions",
      models: structuredClone(VENICE_MODEL_CATALOG),
    },
    modelDiscovery: VENICE_MODEL_DISCOVERY_OPTIONS,
  });
  return provider.models;
}

function livePricing(input: number, output: number, cacheInput?: number, cacheWrite?: number) {
  return {
    input: { usd: input },
    output: { usd: output },
    ...(cacheInput === undefined ? {} : { cache_input: { usd: cacheInput } }),
    ...(cacheWrite === undefined ? {} : { cache_write: { usd: cacheWrite } }),
  };
}

describe("venice-models", () => {
  afterEach(() => {
    clearLiveCatalogCacheForTests();
    vi.unstubAllGlobals();
  });

  it("uses complete live prices for known, new, and free models in the fetched rows", async () => {
    const models = await discoverVeniceModels([
      { id: "grok-4-5", pricing: livePricing(7, 11) },
      { id: "new-priced-model", pricing: livePricing(3, 5, 0.3, 3.75) },
      { id: "qwen-3-7-plus", pricing: livePricing(0, 0) },
    ]);
    expect(models.map(({ cost }) => cost)).toEqual([
      { input: 7, output: 11, cacheRead: 0, cacheWrite: 0 },
      { input: 3, output: 5, cacheRead: 0.3, cacheWrite: 3.75 },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ]);
  });

  it.each([
    {
      ...livePricing(9, 3),
      extended: { context_token_threshold: 17, input: { usd: 12 } },
    },
    {
      ...livePricing(9, 3, 1),
      extended: { context_token_threshold: 17, input: { usd: 12 }, output: { usd: 4 } },
    },
  ])("keeps the whole offline schedule for missing or invalid live pricing %j", async (pricing) => {
    const models = await discoverVeniceModels([
      { id: "grok-4-5", pricing },
      { id: "unknown-invalid-price", pricing },
    ]);
    expect(models[0]?.cost).toEqual(VENICE_MODEL_CATALOG.find(({ id }) => id === "grok-4-5")?.cost);
    expect(models[1]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("projects live cache prices with an integral range strictly above the threshold", async () => {
    const threshold = 17.5;
    const [model] = await discoverVeniceModels([
      {
        id: "new-tiered-model",
        pricing: {
          ...livePricing(3, 5, 0.3, 3.75),
          extended: { context_token_threshold: threshold, ...livePricing(6, 10, 0.6, 7.5) },
        },
      },
    ]);
    expect(model?.cost.tieredPricing).toEqual([
      { input: 3, output: 5, cacheRead: 0.3, cacheWrite: 3.75, range: [0, 18] },
      { input: 6, output: 10, cacheRead: 0.6, cacheWrite: 7.5, range: [18] },
    ]);
  });

  it("preserves the offline qwen-3-7-plus cache prices and context boundary", async () => {
    const id = "qwen-3-7-plus";
    const discovered = await discoverVeniceModels([{ id }]);
    for (const catalog of [VENICE_MODEL_CATALOG, discovered]) {
      expect(catalog.find((model) => model.id === id)?.cost).toEqual({
        input: 0.5,
        output: 2,
        cacheRead: 0.05,
        cacheWrite: 0.625,
        tieredPricing: [
          { input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0.625, range: [0, 256_001] },
          { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.875, range: [256_001] },
        ],
      });
    }
  });

  it.each([
    { context: 50_000, tools: false, cap: 50_000 },
    { context: undefined, tools: true, cap: 128_000 },
  ])("bounds new-model tokens with context $context", async ({ context, tools, cap }) => {
    const [model] = await discoverVeniceModels([
      {
        id: "new-model",
        availableContextTokens: context,
        maxCompletionTokens: 200_000,
        capabilities: { supportsFunctionCalling: tools },
      },
    ]);
    expect(model).toMatchObject({ contextWindow: cap, maxTokens: cap });
    if (!tools) {
      expect(model?.compat?.supportsTools).toBe(false);
    }
  });

  it("ignores missing capabilities on partial metadata instead of aborting discovery", async () => {
    const models = await discoverVeniceModels([
      {
        id: "zai-org-glm-4.7",
        availableContextTokens: 131072,
        maxCompletionTokens: 2048,
      },
      { id: "new-model-partial", maxCompletionTokens: 2048 },
    ]);

    expect(models).toMatchObject([
      { id: "zai-org-glm-4.7", maxTokens: 2048 },
      { id: "new-model-partial", contextWindow: 128000, maxTokens: 2048 },
    ]);
    expect(models[1]?.compat?.supportsTools).toBeUndefined();
  });

  it("keeps known models discoverable when a row omits model_spec", async () => {
    const models = await discoverVeniceModels([
      { id: "qwen3-coder-480b-a35b-instruct-turbo", includeModelSpec: false },
      {
        id: "new-model-valid",
        availableContextTokens: 32_000,
        maxCompletionTokens: 2_048,
        capabilities: { supportsFunctionCalling: true },
      },
    ]);

    expect(models).toMatchObject([
      { id: "qwen3-coder-480b-a35b-instruct-turbo", maxTokens: 65536 },
      { id: "new-model-valid", contextWindow: 32000, maxTokens: 2048 },
    ]);
  });
});
