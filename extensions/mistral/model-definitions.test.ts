import { describe, expect, it } from "vitest";
import {
  buildMistralModelDefinition,
  MISTRAL_DEFAULT_CONTEXT_WINDOW,
  MISTRAL_DEFAULT_COST,
  MISTRAL_DEFAULT_MAX_TOKENS,
  MISTRAL_DEFAULT_MODEL_ID,
} from "./model-definitions.js";

describe("mistral model definitions", () => {
  it("uses current Pi pricing for the bundled default model", () => {
    expect(buildMistralModelDefinition()).toMatchObject({
      id: MISTRAL_DEFAULT_MODEL_ID,
      contextWindow: MISTRAL_DEFAULT_CONTEXT_WINDOW,
      maxTokens: MISTRAL_DEFAULT_MAX_TOKENS,
      cost: MISTRAL_DEFAULT_COST,
    });

    expect(MISTRAL_DEFAULT_COST).toEqual({
      input: 0.5,
      output: 1.5,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
