// Minimax tests cover model definitions plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildMinimaxApiModelDefinition,
  buildMinimaxModelDefinition,
  DEFAULT_MINIMAX_CONTEXT_WINDOW,
  DEFAULT_MINIMAX_MAX_TOKENS,
  MINIMAX_API_COST,
  MINIMAX_API_HIGHSPEED_COST,
  MINIMAX_HOSTED_MODEL_ID,
  MINIMAX_M27_API_COST,
  MINIMAX_M25_API_COST,
  MINIMAX_M25_API_HIGHSPEED_COST,
<<<<<<< HEAD
} from "./model-definitions.js";
import { MINIMAX_TEXT_MODEL_CATALOG } from "./provider-models.js";

const MINIMAX_M3_CATALOG_CONTEXT_WINDOW = MINIMAX_TEXT_MODEL_CATALOG["MiniMax-M3"].contextWindow;
=======
  MINIMAX_M3_CONTEXT_WINDOW,
} from "./model-definitions.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

describe("minimax model definitions", () => {
  it("uses M3 as default hosted model", () => {
    expect(MINIMAX_HOSTED_MODEL_ID).toBe("MiniMax-M3");
  });

  it("uses the current upstream MiniMax context, token, and pricing defaults", () => {
<<<<<<< HEAD
    expect(MINIMAX_M3_CATALOG_CONTEXT_WINDOW).toBe(1_000_000);
=======
    expect(MINIMAX_M3_CONTEXT_WINDOW).toBe(1_000_000);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    expect(DEFAULT_MINIMAX_CONTEXT_WINDOW).toBe(204800);
    expect(DEFAULT_MINIMAX_MAX_TOKENS).toBe(131072);
    expect(MINIMAX_API_COST).toEqual({
      input: 0.6,
      output: 2.4,
      cacheRead: 0.12,
      cacheWrite: 0,
    });
  });

  it("builds catalog model with M3 metadata from the catalog", () => {
    const model = buildMinimaxModelDefinition({
      id: "MiniMax-M3",
      cost: MINIMAX_API_COST,
<<<<<<< HEAD
      contextWindow: MINIMAX_M3_CATALOG_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
    });
    expect(model).toEqual({
      contextWindow: MINIMAX_M3_CATALOG_CONTEXT_WINDOW,
=======
      contextWindow: MINIMAX_M3_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
    });
    expect(model).toEqual({
      contextWindow: MINIMAX_M3_CONTEXT_WINDOW,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      cost: MINIMAX_API_COST,
      id: "MiniMax-M3",
      input: ["text", "image"],
      maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
      name: "MiniMax M3",
      reasoning: true,
    });
  });

  it("builds non-catalog model with generated name and default reasoning", () => {
    const model = buildMinimaxModelDefinition({
      id: "MiniMax-M2.5",
      cost: MINIMAX_API_COST,
      contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
    });
    expect(model).toEqual({
      contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
      cost: MINIMAX_API_COST,
      id: "MiniMax-M2.5",
      input: ["text"],
      maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
      name: "MiniMax MiniMax-M2.5",
      reasoning: false,
    });
  });

  it("builds API model definition with standard cost for M3", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M3");
    expect(model.cost).toEqual(MINIMAX_API_COST);
<<<<<<< HEAD
    expect(model.contextWindow).toBe(MINIMAX_M3_CATALOG_CONTEXT_WINDOW);
=======
    expect(model.contextWindow).toBe(MINIMAX_M3_CONTEXT_WINDOW);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    expect(model.maxTokens).toBe(DEFAULT_MINIMAX_MAX_TOKENS);
    expect(model.input).toEqual(["text", "image"]);
  });

  it("falls back to generated name for unknown model id", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-Future");
    expect(model.name).toBe("MiniMax MiniMax-Future");
    expect(model.reasoning).toBe(false);
  });

  it("keeps M2.7 on its existing price and text-only metadata", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.7");
    expect(model.input).toEqual(["text"]);
    expect(model.cost).toEqual(MINIMAX_M27_API_COST);
    expect(model.contextWindow).toBe(DEFAULT_MINIMAX_CONTEXT_WINDOW);
  });

  it("keeps M2.7 text-only on the Anthropic-compatible chat path", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.7");
    expect(model.input).toEqual(["text"]);
  });

  it("keeps M2.7-highspeed text-only on the Anthropic-compatible chat path", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.7-highspeed");
    expect(model.input).toEqual(["text"]);
    expect(model.cost).toEqual(MINIMAX_API_HIGHSPEED_COST);
  });

  it("M2.5 model remains text-only", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.5");
    expect(model.input).toEqual(["text"]);
    expect(model.cost).toEqual(MINIMAX_M25_API_COST);
  });

  it("M2.5-highspeed keeps the M2.5 cache-read pricing", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.5-highspeed");
    expect(model.cost).toEqual(MINIMAX_M25_API_HIGHSPEED_COST);
  });
});
