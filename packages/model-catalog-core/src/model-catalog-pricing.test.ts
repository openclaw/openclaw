import { describe, expect, it } from "vitest";
import {
  normalizeModelPricingCatalog,
  normalizeModelPricingProvider,
  normalizeOpenRouterModelPricing,
  normalizeUpstreamModelPricing,
} from "./model-catalog-pricing.js";

const BASE_COST = { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 };

describe("model pricing source policy", () => {
  it("normalizes all source mappings without losing explicit opt-outs", () => {
    expect(
      normalizeModelPricingProvider({
        external: false,
        openCode: { provider: " OpenCode ", modelIdTransforms: ["version-dots", "unknown", null] },
        venice: { provider: " Venice " },
        openRouter: { passthroughProviderModel: true },
        liteLLM: false,
      }),
    ).toEqual({
      external: false,
      openCode: { provider: "opencode", modelIdTransforms: ["version-dots"] },
      venice: { provider: "venice" },
      openRouter: { passthroughProviderModel: true },
      liteLLM: false,
    });
  });

  it.each([
    { value: undefined },
    {
      value: {
        openCode: {},
        openRouter: { provider: " " },
        liteLLM: { modelIdTransforms: ["unknown"] },
      },
    },
  ])("ignores empty or unrecognized policy $value", ({ value }) =>
    expect(normalizeModelPricingProvider(value)).toBeUndefined(),
  );
});

describe("native pricing catalogs", () => {
  const paid = { id: "paid", pricing: { input: 2, output: 10 } };

  it("uses the selected identity and validates prices before filtering unsupported schedules", () => {
    const options = {
      readModelId: (row: Record<string, unknown>) => row.model_name,
      readPricing: (row: Record<string, unknown>) => row.cost,
      isSupportedPricing: (value: unknown) => !Object.hasOwn(value as object, "qualified"),
    };
    const native = { id: "ignored", model_name: " paid ", cost: paid.pricing };
    const qualified = { model_name: "qualified", cost: { ...paid.pricing, qualified: true } };
    expect(
      normalizeModelPricingCatalog([native, qualified], normalizeUpstreamModelPricing, options),
    ).toEqual(new Map([["paid", BASE_COST]]));
    for (const rows of [
      [qualified],
      [native, { ...qualified, model_name: "paid" }],
      [native, { model_name: "paid" }],
      [native, { ...qualified, cost: { input: -1, output: 10, qualified: true } }],
    ]) {
      expect(
        normalizeModelPricingCatalog(rows, normalizeUpstreamModelPricing, options),
      ).toBeUndefined();
    }
  });

  it("keeps declared free prices distinct from missing prices", () => {
    expect(
      normalizeModelPricingCatalog(
        [paid, { id: "unknown" }, { id: "free", pricing: { input: 0, output: 0 } }],
        normalizeUpstreamModelPricing,
      ),
    ).toEqual(
      new Map([
        ["paid", BASE_COST],
        ["free", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
      ]),
    );
  });

  it.each([{ label: "non-array", rows: {} }])(
    "rejects $label rather than publishing a partial native feed",
    ({ rows }) => {
      expect(normalizeModelPricingCatalog(rows, normalizeUpstreamModelPricing)).toBeUndefined();
    },
  );
});

describe.each([
  {
    source: "OpenRouter",
    normalize: normalizeOpenRouterModelPricing,
    base: { prompt: "0.000002", completion: "0.00001" },
    input: "prompt",
    output: "completion",
  },
])("$source pricing integrity", ({ normalize, base, input, output }) => {
  it("returns complete per-million rates with absent cache charges defaulted to zero", () => {
    expect(normalize(base)).toEqual(BASE_COST);
    expect(normalize({ [input]: 0, [output]: 0 })).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("OpenRouter native pricing", () => {
  const base = {
    prompt: "0.000002",
    completion: "0.00001",
    input_cache_read: "0.00000025",
    input_cache_write: "0.0000025",
  };
  const cost = { input: 2, output: 10, cacheRead: 0.25, cacheWrite: 2.5 };

  it("compiles unordered overrides in source order per key without borrowing foreign prices", () => {
    const pricing = {
      ...base,
      // Other feed formats must not supply native OpenRouter rates or tiers.
      input: 99,
      context_over_200k: { input: 99, output: 99 },
      overrides: [
        { min_prompt_tokens: 500_000, prompt: "0.000006", completion: "0.00002" },
        { utc_days: [0], utc_start: "00:00", utc_end: "12:00", prompt: "0", completion: "0" },
        { min_prompt_tokens: 100_000, utc_start: "00:00", prompt: "0", completion: "0" },
        {
          min_prompt_tokens: 272_000,
          prompt: "0.000004",
          completion: "0.000015",
          input_cache_read: "0.0000004",
          input_cache_write: "0.000005",
        },
      ],
    };
    expect(normalizeOpenRouterModelPricing(pricing)).toEqual({
      ...cost,
      tieredPricing: [
        { ...cost, range: [0, 272_001] },
        {
          input: 4,
          output: 15,
          cacheRead: expect.closeTo(0.4, 12),
          cacheWrite: 5,
          range: [272_001, 500_001],
        },
        {
          input: 4,
          output: 15,
          cacheRead: expect.closeTo(0.4, 12),
          cacheWrite: 5,
          range: [500_001],
        },
      ],
    });
  });
});

describe("upstream pricing tiers", () => {
  it.each([
    { context_over_200k: { input: 4 } },
    {
      tiers: [
        { tier: { type: "context", size: 272_000 }, input: 4, output: 15 },
        { tier: { type: "context", size: 272_000 }, input: 8, output: 30 },
      ],
    },
  ])(
    "rejects incomplete or conflicting context tiers rather than selecting lower prices: %j",
    (tiers) => {
      expect(normalizeUpstreamModelPricing({ input: 2, output: 10, ...tiers })).toBeUndefined();
    },
  );
});
