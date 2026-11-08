// Minimax tests cover model definitions plugin behavior.
import { describe, expect, it } from "vitest";
import { buildMinimaxApiModelDefinition } from "./model-definitions.js";

describe("minimax model definitions", () => {
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
