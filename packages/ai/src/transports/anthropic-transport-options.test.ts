import { describe, expect, it } from "vitest";
import type { AnthropicOptions } from "../provider-options.js";
import type { Model } from "../types.js";
import { applyAnthropicThinkingOptions } from "./anthropic-transport-options.js";

function makeModel(id: string, maxTokens = 64_000): Model<"anthropic-messages"> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens,
  };
}

describe("applyAnthropicThinkingOptions adaptive token budget reservation", () => {
  it("raises maxTokens when reasoning='off' is coerced to 'low' on mandatory adaptive models", () => {
    const model = makeModel("claude-opus-5-5");
    const resolved: AnthropicOptions & { maxTokens: number } = { maxTokens: 300 };
    const effective = applyAnthropicThinkingOptions(
      model,
      resolved,
      { reasoning: "off" },
      "transport",
    );
    expect(effective).toBe("low");
    expect(resolved.thinkingEnabled).toBe(true);
    expect(resolved.maxTokens).toBe(2348);
  });

  it("raises low maxTokens (<= 1024) when adaptive thinking is active on Claude 4.6/5.5 models", () => {
    const model = makeModel("claude-haiku-5-5");
    const resolved: AnthropicOptions & { maxTokens: number } = { maxTokens: 300 };
    const effective = applyAnthropicThinkingOptions(
      model,
      resolved,
      { reasoning: "high" },
      "provider",
    );
    expect(effective).toBe("high");
    expect(resolved.thinkingEnabled).toBe(true);
    expect(resolved.maxTokens).toBe(16_684);
  });

  it("preserves explicit large maxTokens (> 1024) on adaptive models when reasoning is not coerced from off", () => {
    const model = makeModel("claude-sonnet-4-6");
    const resolved: AnthropicOptions & { maxTokens: number } = { maxTokens: 4096 };
    applyAnthropicThinkingOptions(model, resolved, { reasoning: "medium" }, "transport");
    expect(resolved.thinkingEnabled).toBe(true);
    expect(resolved.maxTokens).toBe(4096);
  });
});
