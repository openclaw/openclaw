import { calculateUsageCost } from "@openclaw/llm-core";
import { assert, expect, it } from "vitest";
import {
  normalizeModelPricingCatalog,
  normalizeModelPricingProvider as normalizePolicy,
  normalizeOpenRouterModelPricing as openRouterPricing,
  normalizeUpstreamModelPricing as upstreamPricing,
} from "./model-catalog-pricing.js";

const BASE_COST = { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 };
const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const BASE_RATES = { prompt: "0.000002", completion: "0.00001" };

function nativeCatalog(rows: unknown) {
  return normalizeModelPricingCatalog(rows, upstreamPricing);
}

it("normalizes all source mappings without losing explicit opt-outs", () => {
  const policy = {
    external: false,
    openCode: { provider: "opencode", modelIdTransforms: ["version-dots"] },
    venice: { provider: "venice" },
    openRouter: { passthroughProviderModel: true },
    liteLLM: false,
  };
  expect(
    normalizePolicy({
      ...policy,
      openCode: { provider: " OpenCode ", modelIdTransforms: ["version-dots", "unknown", null] },
      venice: { provider: " Venice " },
    }),
  ).toEqual(policy);
});

it.each([
  undefined,
  { openCode: {}, openRouter: { provider: " " }, liteLLM: { modelIdTransforms: ["unknown"] } },
])("ignores empty or unrecognized policy %j", (value) =>
  expect(normalizePolicy(value)).toBeUndefined(),
);
const paid = { id: "paid", pricing: { input: 2, output: 10 } };

it("uses the selected identity and validates prices before filtering unsupported schedules", () => {
  const catalog = (rows: unknown) =>
    normalizeModelPricingCatalog(rows, upstreamPricing, {
      readModelId: (row: Record<string, unknown>) => row.model_name,
      readPricing: (row: Record<string, unknown>) => row.cost,
      isSupportedPricing: (value: unknown) => !Object.hasOwn(value as object, "qualified"),
    });
  const native = { id: "ignored", model_name: " paid ", cost: paid.pricing };
  const qualified = { model_name: "qualified", cost: { ...paid.pricing, qualified: true } };
  expect(catalog([native, qualified])).toEqual(new Map([["paid", BASE_COST]]));
  for (const rows of [
    [qualified],
    [native, { ...qualified, model_name: "paid" }],
    [native, { model_name: "paid" }],
    [native, { ...qualified, cost: { input: -1, output: 10, qualified: true } }],
  ]) {
    expect(catalog(rows)).toBeUndefined();
  }
});

it("keeps declared free prices distinct from missing prices", () => {
  expect(
    nativeCatalog([paid, { id: "unknown" }, { id: "free", pricing: { input: 0, output: 0 } }]),
  ).toEqual(
    new Map([
      ["paid", BASE_COST],
      ["free", FREE_COST],
    ]),
  );
});

it("rejects non-arrays rather than publishing a partial native feed", () => {
  expect(nativeCatalog({})).toBeUndefined();
});
const base = {
  ...BASE_RATES,
  input_cache_read: "0.00000025",
  input_cache_write: "0.0000025",
};
const cost = { input: 2, output: 10, cacheRead: 0.25, cacheWrite: 2.5 };

it("returns complete per-million rates with absent cache charges defaulted to zero", () => {
  expect(openRouterPricing(BASE_RATES)).toEqual(BASE_COST);
  expect(openRouterPricing({ prompt: 0, completion: 0 })).toEqual(FREE_COST);
});

it("compiles unordered native overrides per key in source order", () => {
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
  const cacheRead = expect.closeTo(0.4, 12);
  const overrideCost = { input: 4, output: 15, cacheRead, cacheWrite: 5 };
  expect(openRouterPricing(pricing)).toEqual({
    ...cost,
    tieredPricing: [
      { ...cost, range: [0, 272_001] },
      { ...overrideCost, range: [272_001, 500_001] },
      { ...overrideCost, range: [500_001] },
    ],
  });
});
it.each([
  { input: 40, output: 7, cacheRead: 30, cacheWrite: 30, expected: 0.0002325 },
  { input: 41, output: 7, cacheRead: 30, cacheWrite: 30, expected: 0.0003865 },
  { input: 0, output: 1_000, cacheRead: 0, cacheWrite: 0, expected: 0.01 },
])("bills strict prompt boundaries with inherited cache rates: %j", ({ expected, ...usage }) => {
  const pricing = openRouterPricing({
    ...base,
    overrides: [{ min_prompt_tokens: 100, prompt: "0.000004", completion: "0.00002" }],
  });
  assert(pricing, "Expected a complete native schedule");
  expect(calculateUsageCost(usage, pricing).total).toBeCloseTo(expected, 12);
});
it.each([
  { context_over_200k: { input: 4 } },
  {
    tiers: [
      { tier: { type: "context", size: 272_000 }, input: 4, output: 15 },
      { tier: { type: "context", size: 272_000 }, input: 8, output: 30 },
    ],
  },
])("rejects incomplete or conflicting context tiers: %j", (tiers) => {
  expect(upstreamPricing({ input: 2, output: 10, ...tiers })).toBeUndefined();
});
