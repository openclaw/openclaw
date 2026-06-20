// Tests for OpenRouter model ID normalization.
import { describe, expect, it } from "vitest";
import { normalizeOpenRouterApiModelId } from "./models.js";

describe("normalizeOpenRouterApiModelId", () => {
  it("returns undefined for non-string input", () => {
    expect(normalizeOpenRouterApiModelId(undefined)).toBeUndefined();
    expect(normalizeOpenRouterApiModelId(null)).toBeUndefined();
    expect(normalizeOpenRouterApiModelId(123)).toBeUndefined();
  });

  it("returns empty string for empty input", () => {
    expect(normalizeOpenRouterApiModelId("")).toBe("");
  });

  it("normalizes lowercase model IDs", () => {
    expect(normalizeOpenRouterApiModelId("DeepSeek/DeepSeek-V4-Flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("strips openrouter/ prefix from namespaced model IDs", () => {
    expect(normalizeOpenRouterApiModelId("openrouter/deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("keeps openrouter/ prefix for short canonical model IDs without namespace", () => {
    expect(normalizeOpenRouterApiModelId("openrouter/deepseek-v4-flash")).toBe(
      "openrouter/deepseek-v4-flash",
    );
  });

  it("keeps openrouter/ prefix for short canonical model IDs without namespace (case insensitive)", () => {
    expect(normalizeOpenRouterApiModelId("OpenRouter/DeepSeek-V4-Flash")).toBe(
      "openrouter/deepseek-v4-flash",
    );
  });

  it("keeps openrouter/ prefix for auto model", () => {
    expect(normalizeOpenRouterApiModelId("openrouter/auto")).toBe("openrouter/auto");
  });

  it("keeps openrouter/ prefix for fusion model", () => {
    expect(normalizeOpenRouterApiModelId("openrouter/fusion")).toBe("openrouter/fusion");
  });

  it("returns model ID without prefix when no openrouter/ prefix", () => {
    expect(normalizeOpenRouterApiModelId("deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("returns model ID without prefix when no openrouter/ prefix (namespaced)", () => {
    expect(normalizeOpenRouterApiModelId("deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("handles openrouter/ prefix with empty remainder", () => {
    expect(normalizeOpenRouterApiModelId("openrouter/")).toBe("openrouter/");
  });

  it("handles openrouter/ prefix with slash-only remainder", () => {
    expect(normalizeOpenRouterApiModelId("openrouter//")).toBe("openrouter//");
  });
});
