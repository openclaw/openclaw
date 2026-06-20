// OpenRouter tests cover model ID normalization behavior.
import { describe, expect, it } from "vitest";
import {
  isOpenRouterDeepSeekV4ModelId,
  isOpenRouterMistralModelId,
  normalizeOpenRouterApiModelId,
  normalizeOpenRouterModelId,
} from "./models.js";

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
    ["openrouter/bodybuilder", "openrouter/bodybuilder"],
    ["openrouter/free", "openrouter/free"],
    ["openrouter/fusion", "openrouter/fusion"],
    ["openrouter/owl-alpha", "openrouter/owl-alpha"],
    ["openrouter/pareto-code", "openrouter/pareto-code"],
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

  // Short model refs expanded to namespaced upstream slugs (regression fix for #95198)
  it.each([
    ["openrouter/deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
    ["openrouter/deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
  ])("expands short model ref %s to namespaced upstream slug", (input, expected) => {
    expect(normalizeOpenRouterApiModelId(input)).toBe(expected);
  });

  // Unknown single-segment refs preserve prefix (conservative for future native IDs)
  it.each([
    ["openrouter/deepseek-chat-v3", "openrouter/deepseek-chat-v3"],
    ["openrouter/unknown-future-id", "openrouter/unknown-future-id"],
  ])("preserves prefix for unknown single-segment ref %s", (input, expected) => {
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
    expect(normalizeOpenRouterApiModelId("OPENROUTER/DEEPSEEK-V4-FLASH")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });
});

describe("isOpenRouterDeepSeekV4ModelId", () => {
  it.each([
    // Namespaced upstream slugs (as returned by normalizeOpenRouterApiModelId)
    ["deepseek/deepseek-v4-flash", true],
    ["deepseek/deepseek-v4-pro", true],
    // Short refs don't have deepseek/ prefix → not matched
    ["deepseek-v4-flash", false],
    ["deepseek-v4-pro", false],
    // Non-DeepSeek V4 refs
    ["deepseek/deepseek-chat-v3", false],
    ["deepseek/deepseek-v4", false],
    ["anthropic/claude-sonnet-4.6", false],
    ["openrouter/auto", false],
  ])("identifies %s as DeepSeek V4: %s", (input, expected) => {
    expect(isOpenRouterDeepSeekV4ModelId(input)).toBe(expected);
  });
});

describe("isOpenRouterMistralModelId", () => {
  it.each([
    ["mistralai/mistral-large", true],
    ["mistral/mistral-small", true],
    ["mistral-large", true],
    ["codestral-latest", true],
    ["pixtral-large", true],
    ["anthropic/claude-sonnet-4.6", false],
    ["deepseek/deepseek-v4-flash", false],
  ])("identifies %s as Mistral: %s", (input, expected) => {
    expect(isOpenRouterMistralModelId(input)).toBe(expected);
  });
});
