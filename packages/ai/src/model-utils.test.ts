import { describe, expect, it } from "vitest";
import { calculateCost, clampThinkingLevel, getSupportedThinkingLevels } from "./model-utils.js";
import type { Model } from "./types.js";

function makeModel(
  thinkingLevelMap: Model["thinkingLevelMap"],
  overrides: Partial<Model> = {},
): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://example.com",
    reasoning: true,
    thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    ...overrides,
  };
}

describe("calculateCost", () => {
  it.each([
    { cacheWrite1h: undefined, expectedWrite: 0.00012 },
    { cacheWrite1h: -1, expectedWrite: 0.00012 },
    { cacheWrite1h: 40, expectedWrite: 0.00028 },
    { cacheWrite1h: 500, expectedWrite: 0.00036 },
  ])(
    "mutates cost using the prompt tier and bounded 1h writes ($cacheWrite1h)",
    ({ cacheWrite1h, expectedWrite }) => {
      const baseRates = { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 };
      const cost = {
        ...baseRates,
        tieredPricing: [
          { ...baseRates, range: [0, 100] as [number, number] },
          { input: 3, output: 6, cacheRead: 1, cacheWrite: 2, range: [100] as [number] },
        ],
      };
      const usage = {
        input: 20,
        output: 10,
        cacheRead: 30,
        cacheWrite: 60,
        cacheWrite1h,
        totalTokens: 120,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const result = calculateCost(makeModel(undefined, { cost }), usage);
      expect(result).toBe(usage.cost);
      expect(result.input).toBeCloseTo(0.00006, 10);
      expect(result.output).toBeCloseTo(0.00006, 10);
      expect(result.cacheRead).toBeCloseTo(0.00003, 10);
      expect(result.cacheWrite).toBeCloseTo(expectedWrite, 10);
      expect(result.total).toBeCloseTo(0.00015 + expectedWrite, 10);
    },
  );
});

describe("clampThinkingLevel", () => {
  it("downgrades explicit extended-level opt-outs", () => {
    expect(clampThinkingLevel(makeModel({ xhigh: null, max: "max" }), "xhigh")).toBe("high");
  });

  it("keeps upward clamping for lower-level map holes", () => {
    expect(clampThinkingLevel(makeModel({ minimal: null }), "minimal")).toBe("low");
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

  it("honors compat.supportedReasoningEfforts for extended thinking levels without thinkingLevelMap", () => {
    const model = makeModel(undefined, {
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    });

    const levels = getSupportedThinkingLevels(model);
    expect(levels).toContain("xhigh");
    expect(levels).toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("max");
    expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
  });

  it("preserves max for custom provider models with off/minimal null map and compat efforts", () => {
    const model = makeModel(
      { off: null, minimal: null },
      {
        compat: {
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        },
      },
    );

    expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(clampThinkingLevel(model, "max")).toBe("max");
  });

  it("clamps max down to xhigh when compat only declares xhigh", () => {
    const model = makeModel(undefined, {
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    });

    expect(getSupportedThinkingLevels(model)).toContain("xhigh");
    expect(getSupportedThinkingLevels(model)).not.toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("xhigh");
  });

  it("clamps max down to high when compat does not declare extended tiers", () => {
    const model = makeModel(undefined, {
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high"],
      },
    });

    expect(getSupportedThinkingLevels(model)).not.toContain("xhigh");
    expect(getSupportedThinkingLevels(model)).not.toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("high");
  });

  it("preserves explicit null opt-out over compat.supportedReasoningEfforts", () => {
    const model = makeModel(
      { max: null },
      {
        compat: {
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        },
      },
    );

    const levels = getSupportedThinkingLevels(model);
    expect(levels).toContain("xhigh");
    expect(levels).not.toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("xhigh");
  });

  it("does not unlock extended tiers when supportsReasoningEffort is false", () => {
    const model = makeModel(undefined, {
      compat: {
        supportsReasoningEffort: false,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    });

    const levels = getSupportedThinkingLevels(model);
    expect(levels).not.toContain("xhigh");
    expect(levels).not.toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("high");
  });

  it("normalizes reasoning effort casing, trimming, and aliases", () => {
    const model = makeModel(undefined, {
      compat: {
        supportedReasoningEfforts: [" extra-high ", "MAX"],
      },
    });

    const levels = getSupportedThinkingLevels(model);
    expect(levels).toContain("xhigh");
    expect(levels).toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("max");
    expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
  });

  it("never clamps unsupported xhigh upward to max when only max is supported", () => {
    const model = makeModel(undefined, {
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "max"],
      },
    });

    expect(getSupportedThinkingLevels(model)).not.toContain("xhigh");
    expect(getSupportedThinkingLevels(model)).toContain("max");
    // Crucial cost invariant: unsupported xhigh must clamp DOWN to high, NEVER up to max
    expect(clampThinkingLevel(model, "xhigh")).toBe("high");
  });

  it("ignores inherited Object.prototype properties for supportedReasoningEfforts", () => {
    const model = makeModel(undefined, {
      compat: {},
    });

    const proto = Object.prototype as unknown as { supportedReasoningEfforts?: string[] };
    proto.supportedReasoningEfforts = ["max"];
    try {
      const levels = getSupportedThinkingLevels(model);
      expect(levels).not.toContain("max");
      expect(clampThinkingLevel(model, "max")).toBe("high");
    } finally {
      delete proto.supportedReasoningEfforts;
    }
  });
});
