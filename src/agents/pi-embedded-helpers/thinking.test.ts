import { beforeEach, describe, expect, it } from "vitest";
import {
  pickFallbackThinkingLevel,
  pickFallbackThinkingLevelWithCache,
  resetFallbackThinkingCacheForTests,
} from "./thinking.js";

beforeEach(() => {
  resetFallbackThinkingCacheForTests();
});

describe("pickFallbackThinkingLevel", () => {
  it("returns undefined for empty message", () => {
    expect(pickFallbackThinkingLevel({ message: "", attempted: new Set() })).toBeUndefined();
  });

  it("returns undefined for undefined message", () => {
    expect(pickFallbackThinkingLevel({ message: undefined, attempted: new Set() })).toBeUndefined();
  });

  it("extracts supported values from error message", () => {
    const result = pickFallbackThinkingLevel({
      message: 'Supported values are: "high", "medium"',
      attempted: new Set(),
    });
    expect(result).toBe("high");
  });

  it("skips already attempted values", () => {
    const result = pickFallbackThinkingLevel({
      message: 'Supported values are: "high", "medium"',
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

  it('falls back to "off" for generic not-supported messages', () => {
    const result = pickFallbackThinkingLevel({
      message: "thinking level not supported by this provider",
      attempted: new Set(),
    });
    expect(result).toBe("off");
  });

  it('returns undefined if "off" was already attempted', () => {
    const result = pickFallbackThinkingLevel({
      message: '400 think value "low" is not supported for this model',
      attempted: new Set(["off"]),
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for unrelated error messages", () => {
    const result = pickFallbackThinkingLevel({
      message: "rate limit exceeded, please retry after 30 seconds",
      attempted: new Set(),
    });
    expect(result).toBeUndefined();
  });
});

describe("pickFallbackThinkingLevelWithCache", () => {
  it("stores and reuses parsed fallback per provider/model", () => {
    const first = pickFallbackThinkingLevelWithCache({
      message: 'Supported values are: "high", "medium"',
      attempted: new Set(),
      provider: "openai-codex",
      model: "gpt-5.2",
      nowMs: 1,
    });
    expect(first).toEqual({ level: "high", source: "parsed" });

    const second = pickFallbackThinkingLevelWithCache({
      message: "think value low is not supported",
      attempted: new Set(),
      provider: "openai-codex",
      model: "gpt-5.2",
      nowMs: 2,
    });
    expect(second).toEqual({ level: "high", source: "cache" });
  });

  it("does not reuse cached fallback when already attempted", () => {
    pickFallbackThinkingLevelWithCache({
      message: 'Supported values are: "high", "medium"',
      attempted: new Set(),
      provider: "openai-codex",
      model: "gpt-5.2",
      nowMs: 1,
    });

    const result = pickFallbackThinkingLevelWithCache({
      message: "think value low is not supported",
      attempted: new Set(["high"]),
      provider: "openai-codex",
      model: "gpt-5.2",
      nowMs: 2,
    });

    expect(result).toEqual({ level: "off", source: "parsed" });
  });

  it("isolates cache by provider/model", () => {
    pickFallbackThinkingLevelWithCache({
      message: 'Supported values are: "high", "medium"',
      attempted: new Set(),
      provider: "openai-codex",
      model: "gpt-5.2",
      nowMs: 1,
    });

    const otherModel = pickFallbackThinkingLevelWithCache({
      message: "think value low is not supported",
      attempted: new Set(),
      provider: "openai-codex",
      model: "gpt-5.3",
      nowMs: 2,
    });

    expect(otherModel).toEqual({ level: "off", source: "parsed" });
  });
});
