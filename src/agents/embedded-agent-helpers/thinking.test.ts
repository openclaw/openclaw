// Covers fallback thinking-level selection from provider error text.
import { describe, expect, it } from "vitest";
import { pickFallbackThinkingLevel } from "./thinking.js";

describe("pickFallbackThinkingLevel", () => {
  it("returns undefined for undefined message", () => {
    expect(pickFallbackThinkingLevel({ message: undefined, attempted: new Set() })).toBeUndefined();
  });

  it("skips already attempted values", () => {
    const result = pickFallbackThinkingLevel({
      message: 'Unsupported reasoning_effort. Supported values are: "high", "medium"',
      attempted: new Set(["high"]),
    });
    expect(result).toBe("medium");
  });

  it('falls back to "off" when error says "not supported" without listing values', () => {
    const result = pickFallbackThinkingLevel({
      message: '400 think value "low" is not supported for this model',
      attempted: new Set(),
    });
    expect(result).toBe("off");
  });

  it('falls back to "minimal" when the endpoint requires reasoning', () => {
    // Mandatory-reasoning endpoints need the smallest enabled level, not "off".
    const result = pickFallbackThinkingLevel({
      message: "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
      attempted: new Set(["off"]),
    });
    expect(result).toBe("minimal");
  });

  it('returns undefined if "off" was already attempted', () => {
    const result = pickFallbackThinkingLevel({
      message: '400 think value "low" is not supported for this model',
      attempted: new Set(["off"]),
    });
    expect(result).toBeUndefined();
  });

  it.each([
    `400 ${JSON.stringify({ error: { message: '"reasoning_effort" is not supported' } })}`,
    "The 'unavailable-reasoning.effort-model' model is not supported when using Codex with a ChatGPT account.",
  ])("does not retry failures without a supported thinking alternative: %s", (message) => {
    const result = pickFallbackThinkingLevel({
      message,
      attempted: new Set(),
    });
    expect(result).toBeUndefined();
  });
});
