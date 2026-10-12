import { describe, expect, it } from "vitest";
import { resolveAnthropicFallbackServingModelCost } from "./anthropic-server-fallback.js";

const FABLE_COST = Object.freeze({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
const OPUS_FAST_COST = Object.freeze({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
const OPUS_55_FAST_COST = Object.freeze({ input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 });

describe("Anthropic server-side fallback", () => {
  it("preserves requested pricing when Opus 5 falls back to Opus 4.8", () => {
    const customOpusCost = Object.freeze({ input: 12, output: 60, cacheRead: 1.2, cacheWrite: 15 });
    expect(
      resolveAnthropicFallbackServingModelCost({
        requestedModelId: "claude-opus-5",
        servingModelId: "claude-opus-4-8",
        requestedCost: customOpusCost,
      }),
    ).toEqual(customOpusCost);
  });

  it("adjusts Opus base rates while preserving fast pricing", () => {
    expect(
      resolveAnthropicFallbackServingModelCost({
        requestedModelId: "claude-opus-5-5",
        servingModelId: "claude-opus-4-8",
        requestedCost: OPUS_55_FAST_COST,
      }),
    ).toEqual(OPUS_FAST_COST);
  });

  it("keeps requested pricing for an unknown future fallback target", () => {
    expect(
      resolveAnthropicFallbackServingModelCost({
        requestedModelId: "claude-fable-5",
        servingModelId: "claude-future-6",
        requestedCost: FABLE_COST,
      }),
    ).toEqual(FABLE_COST);
  });

  it("preserves fast pricing when an Opus 5 alias resolves to its canonical id", () => {
    expect(
      resolveAnthropicFallbackServingModelCost({
        requestedModelId: "opus-5",
        servingModelId: "claude-opus-5",
        requestedCost: OPUS_FAST_COST,
      }),
    ).toEqual(OPUS_FAST_COST);
  });
});
