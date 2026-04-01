import { describe, it, expect } from "vitest";
import { ModelRegistry } from "../src/model-router/registry.js";
import { ModelResolver } from "../src/model-router/resolver.js";

describe("ModelRouter", () => {
  const registry = new ModelRegistry();
  const resolver = new ModelResolver(registry, {
    fallbackChain: ["claude-sonnet-4-6", "gpt-4.1-mini"],
  });

  it("resolves a requested model when available", () => {
    const result = resolver.resolve("claude-opus-4-6");
    expect(result.modelId).toBe("claude-opus-4-6");
    expect(result.provider).toBe("anthropic");
  });

  it("parses provider/model format", () => {
    const result = resolver.resolve("openai/gpt-4.1");
    expect(result.modelId).toBe("gpt-4.1");
    expect(result.provider).toBe("openai");
  });

  it("returns model spec with pricing", () => {
    const result = resolver.resolve("claude-opus-4-6");
    expect(result.spec.inputPricePer1kTokens).toBe(0.015);
    expect(result.spec.outputPricePer1kTokens).toBe(0.075);
    expect(result.spec.contextWindow).toBe(200_000);
  });

  it("lists all available models (>5, includes key models)", () => {
    const models = registry.listModels();
    expect(models.length).toBeGreaterThan(5);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("claude-opus-4-6");
    expect(ids).toContain("gpt-4.1");
  });

  it("estimates cost correctly", () => {
    const cost = registry.estimateCost("claude-opus-4-6", 1000, 500);
    expect(cost).toBeGreaterThan(0);
    // Expected: (1000/1000)*0.015 + (500/1000)*0.075 = 0.015 + 0.0375 = 0.0525
    expect(cost).toBeCloseTo(0.0525, 4);
  });
});
