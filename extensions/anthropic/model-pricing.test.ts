import { calculateCost, type Usage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { buildAnthropicProvider } from "./register.runtime.js";

const provider = buildAnthropicProvider();

function priceUsage(
  modelId: string,
  tokens: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h">,
) {
  const model = provider.resolveDynamicModel?.({
    provider: "anthropic",
    modelId,
    modelRegistry: {
      find: () => undefined,
      getAll: () => [],
      getAvailable: () => [],
      hasConfiguredAuth: () => false,
    },
  });
  if (!model) {
    throw new Error(`Missing Anthropic model: ${modelId}`);
  }
  const usage: Usage = {
    ...tokens,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return calculateCost({ ...model, compat: undefined }, usage);
}

describe("Anthropic Sonnet 5.5 usage pricing", () => {
  it.each([
    {
      input: 1_513,
      output: 6_900,
      cacheRead: 343_033,
      cacheWrite: 59_001,
      expectedRead: 0.0343033,
      expectedTotal: 0.2538318,
    },
    {
      input: 505,
      output: 1_700,
      cacheRead: 35_473,
      cacheWrite: 13_844,
      expectedRead: 0.0035473,
      expectedTotal: 0.0561673,
    },
  ])("prices $cacheRead cached tokens at the API rate", (sample) => {
    const cost = priceUsage("claude-sonnet-5-5", sample);
    expect(cost.cacheRead).toBeCloseTo(sample.expectedRead, 10);
    expect(cost.total).toBeCloseTo(sample.expectedTotal, 10);
  });

  it.each([
    "sonnet",
    "sonnet-5.5",
    "sonnet-5-5",
    "claude-sonnet-5.5",
    "claude-sonnet-5-5-20260928",
  ])("uses the same cache-read rate for %s", (modelId) => {
    expect(
      priceUsage(modelId, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }).total,
    ).toBe(0.1);
  });

  it("keeps one-hour writes separate from five-minute writes", () => {
    const cost = priceUsage("claude-sonnet-5-5", {
      input: 0,
      output: 0,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
      cacheWrite1h: 250_000,
    });
    expect(cost.cacheWrite).toBe(2.875);
    expect(cost.total).toBeCloseTo(2.975, 10);
  });

  it("preserves the Sonnet 5 cache-read rate", () => {
    expect(
      priceUsage("claude-sonnet-5", {
        input: 0,
        output: 0,
        cacheRead: 1_000_000,
        cacheWrite: 0,
      }).total,
    ).toBe(0.2);
  });
});
