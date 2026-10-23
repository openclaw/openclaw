import { calculateCost, type Model, type Usage } from "openclaw/plugin-sdk/llm";
import {
  buildOpenAICompatibleLiveModelProviderConfig,
  clearLiveCatalogCacheForTests,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
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

function priceUsage(cost: Model<"openai-completions">["cost"], tokens: Partial<Usage>) {
  const usage = { ...createZeroUsageFixture(), ...tokens };
  return calculateCost(
    {
      id: "test-model",
      name: "test-model",
      provider: "venice",
      api: "openai-completions",
      baseUrl: VENICE_BASE_URL,
      reasoning: false,
      input: ["text"],
      cost,
      contextWindow: 1_000_000,
      maxTokens: 4096,
    },
    usage,
  );
}

describe("venice-models", () => {
  afterEach(() => {
    clearLiveCatalogCacheForTests();
    vi.unstubAllGlobals();
  });

  it("uses complete live prices for known, new, and free models in the fetched rows", async () => {
    const models = await discoverVeniceModels([
      { id: "grok-4-5", pricing: { input: { usd: 7 }, output: { usd: 11 } } },
      {
        id: "new-priced-model",
        pricing: {
          input: { usd: 3 },
          output: { usd: 5 },
          cache_input: { usd: 0.3 },
          cache_write: { usd: 3.75 },
        },
      },
      { id: "qwen-3-7-plus", pricing: { input: { usd: 0 }, output: { usd: 0 } } },
    ]);
    expect(models.map(({ cost }) => cost)).toEqual([
      { input: 7, output: 11, cacheRead: 0, cacheWrite: 0 },
      { input: 3, output: 5, cacheRead: 0.3, cacheWrite: 3.75 },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    {
      input: { usd: 9 },
      output: { usd: 3 },
      extended: { context_token_threshold: 17, input: { usd: 12 } },
    },
    {
      input: { usd: 9 },
      output: { usd: 3 },
      cache_input: { usd: 1 },
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

  it("prices the entire request only above the live threshold, including cached tokens", async () => {
    const threshold = 17.5;
    const [model] = await discoverVeniceModels([
      {
        id: "new-tiered-model",
        pricing: {
          input: { usd: 3 },
          output: { usd: 5 },
          cache_input: { usd: 0.3 },
          cache_write: { usd: 3.75 },
          extended: {
            context_token_threshold: threshold,
            input: { usd: 6 },
            output: { usd: 10 },
            cache_input: { usd: 0.6 },
            cache_write: { usd: 7.5 },
          },
        },
      },
    ]);
    const start = Math.floor(threshold) + 1;
    expect(model?.cost.tieredPricing).toEqual([
      { input: 3, output: 5, cacheRead: 0.3, cacheWrite: 3.75, range: [0, start] },
      { input: 6, output: 10, cacheRead: 0.6, cacheWrite: 7.5, range: [start] },
    ]);
    for (const prompt of [Math.floor(threshold), start]) {
      const cacheRead = Math.floor(prompt / 3);
      const cacheWrite = Math.floor(prompt / 3);
      const input = prompt - cacheRead - cacheWrite;
      const cost = priceUsage(model!.cost, {
        input,
        output: 100,
        cacheRead,
        cacheWrite,
        totalTokens: prompt + 100,
      });
      expect(cost.total).toBeCloseTo(
        ((input * 3 + 100 * 5 + cacheRead * 0.3 + cacheWrite * 3.75) *
          (prompt > threshold ? 2 : 1)) /
          1_000_000,
        10,
      );
    }
  });

  it("prices qwen-3-7-plus at cached and uncached context boundaries", async () => {
    const id = "qwen-3-7-plus";
    const threshold = 256_000;
    const base = { input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0.625 };
    const extended = { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.875 };
    const discovered = await discoverVeniceModels([{ id }]);
    for (const catalog of [VENICE_MODEL_CATALOG, discovered]) {
      const definition = catalog.find((model) => model.id === id)!;
      for (const prompt of [threshold - 1, threshold, threshold + 1]) {
        for (const [cacheRead, cacheWrite] of [
          [0, 0],
          [prompt - 100_000, 0],
          [prompt, 0],
          [prompt - 100_000, 50_000],
        ] as const) {
          const usage = {
            input: prompt - cacheRead - cacheWrite,
            output: 1000,
            cacheRead,
            cacheWrite,
            totalTokens: prompt + 1000,
          };
          const cost = priceUsage(definition.cost, usage);
          const rates = prompt > threshold ? extended : base;
          for (const bucket of ["input", "output", "cacheRead", "cacheWrite"] as const) {
            expect(cost[bucket]).toBeCloseTo((usage[bucket] * rates[bucket]) / 1_000_000, 10);
          }
          expect(cost.total).toBeCloseTo(
            (usage.input * rates.input +
              1000 * rates.output +
              cacheRead * rates.cacheRead +
              cacheWrite * rates.cacheWrite) /
              1_000_000,
            10,
          );
        }
      }
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
    expect(model?.maxTokens).toBeLessThanOrEqual(model?.contextWindow ?? Infinity);
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
      {
        id: "new-model-partial",
        maxCompletionTokens: 2048,
      },
    ]);

    const knownModel = models.find((m) => m.id === "zai-org-glm-4.7");
    const partialModel = models.find((m) => m.id === "new-model-partial");
    expect(models).not.toHaveLength(VENICE_MODEL_CATALOG.length);
    expect(knownModel?.maxTokens).toBe(2048);
    expect(partialModel).toMatchObject({ contextWindow: 128000, maxTokens: 2048 });
    expect(partialModel?.compat?.supportsTools).toBeUndefined();
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

    const knownModel = models.find((m) => m.id === "qwen3-coder-480b-a35b-instruct-turbo");
    const newModel = models.find((m) => m.id === "new-model-valid");
    expect(models).not.toHaveLength(VENICE_MODEL_CATALOG.length);
    expect(knownModel?.maxTokens).toBe(65536);
    expect(newModel).toMatchObject({ contextWindow: 32000, maxTokens: 2048 });
  });
});
