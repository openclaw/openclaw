import { describe, expect, it } from "vitest";
import { buildMistralModelDefinition, MISTRAL_DEFAULT_MODEL_ID } from "./model-definitions.js";
import { buildMistralProvider } from "./provider-catalog.js";

describe("mistral model definitions", () => {
  it("uses current OpenClaw pricing for the default model", () => {
    const model = buildMistralModelDefinition();
    expect(model.id).toBe(MISTRAL_DEFAULT_MODEL_ID);
    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(16384);
    expect(model.cost).toEqual({
      input: 0.5,
      output: 1.5,
      cacheRead: 0.05,
      cacheWrite: 0,
    });
  });

  it("prices cached Mistral input tokens at ten percent of standard input tokens", () => {
    for (const model of buildMistralProvider().models) {
      expect(model.cost.cacheRead).toBeCloseTo(model.cost.input * 0.1, 10);
      expect(model.cost.cacheWrite).toBe(0);
    }
  });
});
