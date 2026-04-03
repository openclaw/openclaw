/**
 * Tests for Prompt Caching
 */

import { describe, it, expect } from "vitest";
import {
  isCacheEligibleProvider,
  addCacheControlToText,
  addCacheControlToBlocks,
  addCacheControlToSystemPrompt,
  addCacheControlToMessages,
  calculateCacheSavings,
} from "./prompt-caching.js";

describe("isCacheEligibleProvider", () => {
  it("should return true for Anthropic providers", () => {
    expect(isCacheEligibleProvider("anthropic")).toBe(true);
    expect(isCacheEligibleProvider("Anthropic")).toBe(true);
    expect(isCacheEligibleProvider("ANTHROPIC")).toBe(true);
  });

  it("should return true for Anthropic Bedrock", () => {
    expect(isCacheEligibleProvider("anthropic-bedrock")).toBe(true);
  });

  it("should return true for Anthropic Vertex", () => {
    expect(isCacheEligibleProvider("anthropic-vertex")).toBe(true);
  });

  it("should return true for OpenRouter", () => {
    expect(isCacheEligibleProvider("openrouter")).toBe(true);
  });

  it("should return true for custom Anthropic API", () => {
    expect(isCacheEligibleProvider("custom-provider", "anthropic-messages")).toBe(true);
  });

  it("should return false for other providers", () => {
    expect(isCacheEligibleProvider("openai")).toBe(false);
    expect(isCacheEligibleProvider("google")).toBe(false);
    expect(isCacheEligibleProvider("ollama")).toBe(false);
  });
});

describe("addCacheControlToText", () => {
  const longText = "x".repeat(2000);
  const shortText = "x".repeat(100);

  it("should add cache_control for eligible provider with long text", () => {
    const result = addCacheControlToText(longText, "anthropic");
    expect(result.type).toBe("text");
    expect(result.text).toBe(longText);
    expect(result.cache_control).toEqual({ type: "ephemeral" });
  });

  it("should NOT add cache_control for short text", () => {
    const result = addCacheControlToText(shortText, "anthropic");
    expect(result.cache_control).toBeUndefined();
  });

  it("should NOT add cache_control for ineligible provider", () => {
    const result = addCacheControlToText(longText, "openai");
    expect(result.cache_control).toBeUndefined();
  });

  it("should NOT add cache_control when disabled", () => {
    const result = addCacheControlToText(longText, "anthropic", { enabled: false });
    expect(result.cache_control).toBeUndefined();
  });

  it("should respect custom threshold", () => {
    const result = addCacheControlToText(shortText, "anthropic", { thresholdChars: 50 });
    expect(result.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("addCacheControlToBlocks", () => {
  const blocks = [
    { type: "text" as const, text: "x".repeat(2000) },
    { type: "text" as const, text: "short" },
    { type: "image" as const, source: { type: "base64", media_type: "image/png", data: "abc" } },
  ];

  it("should add cache_control to long text blocks", () => {
    const result = addCacheControlToBlocks(blocks, "anthropic");
    expect(result[0].cache_control).toEqual({ type: "ephemeral" });
    expect(result[1].cache_control).toBeUndefined();
  });

  it("should not modify non-text blocks", () => {
    const result = addCacheControlToBlocks(blocks, "anthropic");
    expect(result[2]).toEqual(blocks[2]);
  });
});

describe("addCacheControlToSystemPrompt", () => {
  const longPrompt = "system prompt ".repeat(200);
  const shortPrompt = "system prompt";

  it("should add cache_control to long system prompts", () => {
    const result = addCacheControlToSystemPrompt(longPrompt, "anthropic");
    expect(result).toHaveLength(1);
    expect(result[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("should NOT add cache_control to short system prompts", () => {
    const result = addCacheControlToSystemPrompt(shortPrompt, "anthropic");
    expect(result[0].cache_control).toBeUndefined();
  });
});

describe("addCacheControlToMessages", () => {
  const messages = [
    { role: "user", content: "x".repeat(2000) },
    { role: "assistant", content: "response" },
    { role: "user", content: [{ type: "text", text: "x".repeat(2000) }] },
  ];

  it("should add cache_control to user messages with long content", () => {
    const result = addCacheControlToMessages(messages, "anthropic");
    
    // First user message (string content)
    const firstUser = result[0];
    expect(firstUser.role).toBe("user");
    if (Array.isArray(firstUser.content)) {
      expect(firstUser.content[0].cache_control).toEqual({ type: "ephemeral" });
    }
    
    // Assistant message should not be modified
    expect(result[1]).toEqual(messages[1]);
  });

  it("should not modify messages for ineligible provider", () => {
    const result = addCacheControlToMessages(messages, "openai");
    expect(result).toEqual(messages);
  });
});

describe("calculateCacheSavings", () => {
  it("should calculate savings from cache read", () => {
    const savings = calculateCacheSavings(10000, 0);
    expect(savings.tokensReadFromCache).toBe(10000);
    expect(savings.estimatedSavingsPercent).toBeGreaterThan(80);
  });

  it("should account for cache write cost", () => {
    const savings = calculateCacheSavings(10000, 5000);
    expect(savings.tokensCached).toBe(5000);
    expect(savings.estimatedSavingsPercent).toBeGreaterThan(50);
  });

  it("should return 0 savings for no cache usage", () => {
    const savings = calculateCacheSavings(0, 0);
    expect(savings.estimatedSavingsPercent).toBe(0);
  });
});
