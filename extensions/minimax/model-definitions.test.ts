// Minimax tests cover model definitions plugin behavior.
import { describe, expect, it } from "vitest";
import { buildMinimaxApiModelDefinition } from "./model-definitions.js";

const EXPECTED_DEFAULT_CONTEXT_WINDOW = 204800;

describe("minimax model definitions", () => {
  it("builds the M3 API model with its catalog metadata and upstream defaults", () => {
    expect(buildMinimaxApiModelDefinition("MiniMax-M3")).toEqual({
      compat: { codeMode: "preferred" },
      contextWindow: 1_000_000,
      cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
      id: "MiniMax-M3",
      input: ["text", "image"],
      maxTokens: 131072,
      name: "MiniMax M3",
      reasoning: true,
    });
  });

  it("falls back to generated metadata for an unknown model id", () => {
    expect(buildMinimaxApiModelDefinition("MiniMax-Future")).toEqual({
      contextWindow: EXPECTED_DEFAULT_CONTEXT_WINDOW,
      cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
      id: "MiniMax-Future",
      input: ["text"],
      maxTokens: 131072,
      name: "MiniMax MiniMax-Future",
      reasoning: false,
    });
  });

  it("keeps M2.7 on its existing price and text-only metadata", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.7");
    expect(model.input).toEqual(["text"]);
    expect(model.cost).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 });
    expect(model.contextWindow).toBe(EXPECTED_DEFAULT_CONTEXT_WINDOW);
  });

  it("keeps M2.7-highspeed text-only on the Anthropic-compatible chat path", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.7-highspeed");
    expect(model.input).toEqual(["text"]);
    expect(model.cost).toEqual({ input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 });
  });

  it("M2.5 model remains text-only", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.5");
    expect(model.input).toEqual(["text"]);
    expect(model.cost).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 });
  });

  it("M2.5-highspeed keeps the M2.5 cache-read pricing", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.5-highspeed");
    expect(model.cost).toEqual({ input: 0.6, output: 2.4, cacheRead: 0.03, cacheWrite: 0.375 });
  });
});
