// OpenRouter tests cover model ID normalization behavior.
import { describe, expect, it } from "vitest";
import { normalizeOpenRouterApiModelId, normalizeOpenRouterModelId } from "./models.js";

describe("normalizeOpenRouterModelId", () => {
  it("strips openrouter/ prefix", () => {
    expect(normalizeOpenRouterModelId("openrouter/auto")).toBe("auto");
  });

  it("returns non-prefixed model ids unchanged", () => {
    expect(normalizeOpenRouterModelId("anthropic/claude-sonnet-4.6")).toBe(
      "anthropic/claude-sonnet-4.6",
    );
  });

  it("returns undefined for non-string input", () => {
    expect(normalizeOpenRouterModelId(undefined)).toBeUndefined();
    expect(normalizeOpenRouterModelId(123)).toBeUndefined();
  });
});

describe("normalizeOpenRouterApiModelId", () => {
  // Real OpenRouter routing slugs and native model IDs (preserve prefix for API calls)
  it.each([
    ["openrouter/auto", "openrouter/auto"],
    ["openrouter/auto:free", "openrouter/auto:free"],
    ["openrouter/auto:lowest-latency", "openrouter/auto:lowest-latency"],
    ["openrouter/fusion", "openrouter/fusion"],
    ["openrouter/hunter-alpha", "openrouter/hunter-alpha"],
    ["openrouter/hunter-alpha:1", "openrouter/hunter-alpha:1"],
  ])("preserves OpenRouter-native identifier %s", (input, expected) => {
    expect(normalizeOpenRouterApiModelId(input)).toBe(expected);
  });

  // Provider-namespaced refs (existing behavior)
  it.each([
    ["openrouter/anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4.6"],
    ["openrouter/deepseek/deepseek-chat-v3", "deepseek/deepseek-chat-v3"],
    ["openrouter/moonshotai/kimi-k2.6", "moonshotai/kimi-k2.6"],
  ])("strips prefix from namespaced ref %s", (input, expected) => {
    expect(normalizeOpenRouterApiModelId(input)).toBe(expected);
  });

  // Short model refs (regression fix for #95198 — not OpenRouter-native IDs)
  it.each([
    ["openrouter/deepseek-v4-flash", "deepseek-v4-flash"],
    ["openrouter/deepseek-v4-pro", "deepseek-v4-pro"],
    ["openrouter/deepseek-chat-v3", "deepseek-chat-v3"],
  ])("strips prefix from short model ref %s", (input, expected) => {
    expect(normalizeOpenRouterApiModelId(input)).toBe(expected);
  });

  // Non-openrouter model ids pass through unchanged
  it.each([
    ["anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4.6"],
    ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
    ["moonshotai/kimi-k2.6", "moonshotai/kimi-k2.6"],
  ])("passes through non-openrouter ref %s", (input, expected) => {
    expect(normalizeOpenRouterApiModelId(input)).toBe(expected);
  });

  it("returns undefined for non-string input", () => {
    expect(normalizeOpenRouterApiModelId(undefined)).toBeUndefined();
    expect(normalizeOpenRouterApiModelId(123)).toBeUndefined();
  });

  it("handles uppercase input", () => {
    expect(normalizeOpenRouterApiModelId("OPENROUTER/DEEPSEEK-V4-FLASH")).toBe("deepseek-v4-flash");
  });
});
