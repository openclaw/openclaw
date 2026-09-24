import { describe, expect, it } from "vitest";
import {
  CLAUDE_OPUS_FALLBACK_MODEL_COST,
  resolveAnthropicFallbackServingModelCost,
} from "./anthropic-server-fallback.js";

const FABLE_COST = Object.freeze({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
const OPUS_FAST_COST = Object.freeze({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
const OPUS_55_COST = Object.freeze({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
const OPUS_55_FAST_COST = Object.freeze({ input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 });

describe("Anthropic server-side fallback", () => {
  it.each([
    { servingModelId: "claude-opus-5", expectedCost: CLAUDE_OPUS_FALLBACK_MODEL_COST },
    { servingModelId: "claude-opus-4-8", expectedCost: CLAUDE_OPUS_FALLBACK_MODEL_COST },
    { servingModelId: "claude-opus-5-5", expectedCost: OPUS_55_COST },
  ])(
    "uses standard Opus pricing when Fable falls back to $servingModelId",
    ({ servingModelId, expectedCost }) => {
      expect(
        resolveAnthropicFallbackServingModelCost({
          requestedModelId: "claude-fable-5",
          servingModelId,
          requestedCost: FABLE_COST,
        }),
      ).toEqual(expectedCost);
    },
  );

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

  it.each([
    {
      requestedModelId: "claude-opus-5-5",
      servingModelId: "claude-opus-5",
      requestedCost: OPUS_55_COST,
      expectedCost: CLAUDE_OPUS_FALLBACK_MODEL_COST,
    },
    {
      requestedModelId: "claude-opus-5-5",
      servingModelId: "claude-opus-4-8",
      requestedCost: OPUS_55_FAST_COST,
      expectedCost: OPUS_FAST_COST,
    },
    {
      requestedModelId: "claude-opus-5",
      servingModelId: "claude-opus-5-5",
      requestedCost: OPUS_FAST_COST,
      expectedCost: OPUS_55_FAST_COST,
    },
  ])(
    "adjusts Opus base rates from $requestedModelId to $servingModelId",
    ({ expectedCost, ...params }) => {
      expect(resolveAnthropicFallbackServingModelCost(params)).toEqual(expectedCost);
    },
  );

  it("keeps requested pricing for an unknown future fallback target", () => {
    expect(
      resolveAnthropicFallbackServingModelCost({
        requestedModelId: "claude-fable-5",
        servingModelId: "claude-future-6",
        requestedCost: FABLE_COST,
      }),
    ).toEqual(FABLE_COST);
  });

  it.each([
    {
      requestedModelId: "opus",
      servingModelId: "claude-opus-5-5",
      requestedCost: OPUS_55_FAST_COST,
    },
    { requestedModelId: "opus-5", servingModelId: "claude-opus-5", requestedCost: OPUS_FAST_COST },
    {
      requestedModelId: "opus-5.5",
      servingModelId: "claude-opus-5-5",
      requestedCost: OPUS_55_FAST_COST,
    },
  ])("preserves fast pricing when $requestedModelId resolves to its canonical id", (params) => {
    expect(resolveAnthropicFallbackServingModelCost(params)).toEqual(params.requestedCost);
  });
});
