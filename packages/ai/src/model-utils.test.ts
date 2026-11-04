import {
  calculateUsageCost,
  normalizeResolvedPricing,
  normalizeUsageCost,
  type RawModelCostConfig,
  type Usage,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  applyProviderReportedUsageCost,
  calculateCost,
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "./model-utils.js";
import { makeProviderModel } from "./providers/provider-model.test-support.js";
import type { Model } from "./types.js";
import { createZeroUsage } from "./utils/usage.js";

function makeModel(
  thinkingLevelMap: Model["thinkingLevelMap"],
  overrides: Partial<Model> = {},
): Model {
  return makeProviderModel("openai-responses", "openai", "test-model", {
    name: "Test Model",
    baseUrl: "https://example.com",
    thinkingLevelMap,
    maxTokens: 4096,
    ...overrides,
  });
}

describe("clampThinkingLevel", () => {
  it("honors a mapped logical Max opt-out on the transport alias", () => {
    const model = makeModel(
      { max: null },
      {
        api: "openclaw-openai-responses-transport",
        compat: {
          supportedReasoningEfforts: ["ProviderLow", "ProviderHigh"],
          reasoningEffortMap: { high: "ProviderLow", MAX: "ProviderHigh" },
        },
      },
    );

    expect(getSupportedThinkingLevels(model)).not.toContain("max");
  });

  it.each(["anthropic-messages"] as const)("does not apply OpenAI compat levels to %s", (api) => {
    const model = makeModel(undefined, {
      api,
      compat: { supportedReasoningEfforts: ["max"] },
    });
    expect(clampThinkingLevel(model, "max")).toBe("high");
  });

  it.each([
    { api: "openclaw-openai-completions-transport", compat: { supportsReasoningEffort: false } },
  ])(
    "does not expose mapped extended levels when scalar effort is disabled: $api $compat",
    ({ api, compat }) => {
      const model = makeModel({ xhigh: "xhigh", max: "max" }, { api, compat });

      expect(getSupportedThinkingLevels(model)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
      ]);
      expect(clampThinkingLevel(model, "xhigh")).toBe("high");
      expect(clampThinkingLevel(model, "max")).toBe("high");
    },
  );

  it("downgrades explicit extended-level opt-outs", () => {
    expect(clampThinkingLevel(makeModel({ xhigh: null, max: "max" }), "xhigh")).toBe("high");
  });

  it("honors canonical Fable capabilities when catalog reasoning is stale", () => {
    const model = makeModel(undefined, {
      id: "company-fable",
      api: "anthropic-messages",
      provider: "microsoft-foundry",
      reasoning: false,
      params: { canonicalModelId: "claude-fable-5" },
    });

    expect(getSupportedThinkingLevels(model)).toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("max");
  });
});

describe("unknown pricing", () => {
  const counts = { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 };
  it.each([
    [undefined, { cacheRead: 0, cacheWrite: 0 }],
    [{ input: 2 }, { input: 2, cacheRead: 0, cacheWrite: 0 }],
    [
      { input: 2, output: 0 },
      { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
    ],
    [
      { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 },
      { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, total: 4 },
    ],
  ] satisfies Array<[RawModelCostConfig | undefined, Usage["cost"]]>)(
    "retains absence and measured zero for %j",
    (pricing, expected) => {
      expect(calculateUsageCost(counts, pricing)).toEqual(expected);
      const normalized = normalizeResolvedPricing(pricing);
      expect(normalized).toEqual(pricing);
      if (normalized) {
        const storedPricing = JSON.stringify(normalized);
        expect(calculateUsageCost(counts, JSON.parse(storedPricing))).toEqual(expected);
      }
    },
  );

  it("does not treat missing quantities as measured zero", () => {
    expect(calculateUsageCost({}, { input: 2 })).toEqual({});
    expect(calculateUsageCost({}, { input: 0 })).toEqual({ input: 0 });
    expect(calculateUsageCost({ input: 0 }, undefined)).toEqual({ input: 0 });
    expect(calculateUsageCost({ cacheWrite: 10, cacheWrite1h: 5 }, { cacheWrite: 0 })).toEqual({});
  });

  it("keeps unknown tier selection unknown and retains complete schedules", () => {
    const rates = { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 };
    const pricing = { ...rates, tieredPricing: [{ ...rates, range: [0, 10] as [number, number] }] };
    expect(calculateUsageCost({ output: 1 }, pricing)).toEqual({});
    expect(
      calculateUsageCost({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, pricing).total,
    ).toBeCloseTo(0.000006);
  });

  it.each([0, 0.25])("preserves billed total %s independently of missing buckets", (billed) => {
    const usage = { ...createZeroUsage(), ...counts };
    const model = makeModel(undefined, { cost: { input: 2 } });
    calculateCost(model, usage);
    expect(usage.cost.total).toBeUndefined();
    applyProviderReportedUsageCost(usage, billed);
    calculateCost(model, usage);
    const storedCost = JSON.stringify(usage.cost);
    expect(normalizeUsageCost(JSON.parse(storedCost))).toEqual({
      input: 2,
      cacheRead: 0,
      cacheWrite: 0,
      total: billed,
      totalOrigin: "provider-billed",
    });
    expect(usage.cost.output).toBeUndefined();
  });

  it("removes stale estimates when later usage has unknown prices", () => {
    const usage = { ...createZeroUsage(), ...counts, cost: { input: 8, output: 9, total: 17 } };
    calculateCost(makeModel(undefined, { cost: undefined }), usage);
    expect(usage.cost).toEqual({ cacheRead: 0, cacheWrite: 0 });
    expect(normalizeUsageCost({ input: 0, output: Infinity, cacheRead: -1 })).toEqual({ input: 0 });
  });
});
