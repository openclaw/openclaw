// Openrouter models tests cover model ID normalization and alias expansion.
import { describe, expect, it } from "vitest";
import {
  normalizeOpenRouterModelId,
  normalizeOpenRouterApiModelId,
  isOpenRouterMistralModelId,
  isOpenRouterDeepSeekV4ModelId,
} from "./models.js";

describe("normalizeOpenRouterApiModelId", () => {
  it("returns undefined for non-string input", () => {
    expect(normalizeOpenRouterApiModelId(undefined)).toBeUndefined();
    expect(normalizeOpenRouterApiModelId(null)).toBeUndefined();
    expect(normalizeOpenRouterApiModelId(42)).toBeUndefined();
    expect(normalizeOpenRouterApiModelId({})).toBeUndefined();
  });

  it("passes through non-openrouter model IDs unchanged", () => {
    expect(normalizeOpenRouterApiModelId("deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
    expect(normalizeOpenRouterApiModelId("anthropic/claude-opus-4-8")).toBe(
      "anthropic/claude-opus-4-8",
    );
    expect(normalizeOpenRouterApiModelId("unknown-model")).toBe("unknown-model");
  });

  it("strips openrouter/ prefix when remainder contains a namespace", () => {
    expect(normalizeOpenRouterApiModelId("openrouter/deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
    expect(normalizeOpenRouterApiModelId("openrouter/anthropic/claude-opus-4-8")).toBe(
      "anthropic/claude-opus-4-8",
    );
  });

  it("expands known short aliases to full namespaced model IDs", () => {
    expect(normalizeOpenRouterApiModelId("openrouter/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
    expect(normalizeOpenRouterApiModelId("openrouter/deepseek-v4-pro")).toBe(
      "deepseek/deepseek-v4-pro",
    );
  });

  it("returns the original prefixed form for unknown short aliases", () => {
    expect(normalizeOpenRouterApiModelId("openrouter/unknown-model")).toBe(
      "openrouter/unknown-model",
    );
    expect(normalizeOpenRouterApiModelId("openrouter/some-other-v1")).toBe(
      "openrouter/some-other-v1",
    );
  });

  it("normalizes case via the lowercase helper", () => {
    expect(normalizeOpenRouterApiModelId("OPENROUTER/DEEPSEEK-V4-FLASH")).toBe(
      "deepseek/deepseek-v4-flash",
    );
    expect(normalizeOpenRouterApiModelId("OpenRouter/DeepSeek-V4-Pro")).toBe(
      "deepseek/deepseek-v4-pro",
    );
  });

  it("is not vulnerable to prototype pollution via plain object lookup", () => {
    // Plain objects have inherited keys like "constructor", "__proto__", and "toString";
    // using Map ensures only explicitly defined keys are matched.
    // Note: normalizeLowercaseStringOrEmpty lowercases the input first.
    expect(normalizeOpenRouterApiModelId("openrouter/constructor")).toBe("openrouter/constructor");
    expect(normalizeOpenRouterApiModelId("openrouter/__proto__")).toBe("openrouter/__proto__");
    expect(normalizeOpenRouterApiModelId("openrouter/tostring")).toBe("openrouter/tostring");
  });
});

describe("normalizeOpenRouterModelId", () => {
  it("returns undefined for non-string input", () => {
    expect(normalizeOpenRouterModelId(undefined)).toBeUndefined();
    expect(normalizeOpenRouterModelId(null)).toBeUndefined();
  });

  it("strips openrouter/ prefix regardless of namespace", () => {
    expect(normalizeOpenRouterModelId("openrouter/deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
    expect(normalizeOpenRouterModelId("openrouter/deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("passes through non-prefixed model IDs unchanged", () => {
    expect(normalizeOpenRouterModelId("deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });
});

describe("isOpenRouterMistralModelId", () => {
  it("detects known Mistral model prefixes", () => {
    expect(isOpenRouterMistralModelId("openrouter/mistralai/mixtral-8x7b")).toBe(true);
    expect(isOpenRouterMistralModelId("mistralai/mixtral-8x7b")).toBe(true);
    expect(isOpenRouterMistralModelId("mistral/mistral-7b")).toBe(true);
  });

  it("returns false for non-Mistral models", () => {
    expect(isOpenRouterMistralModelId("deepseek/deepseek-v4-flash")).toBe(false);
    expect(isOpenRouterMistralModelId("openrouter/deepseek-v4-flash")).toBe(false);
  });
});

describe("isOpenRouterDeepSeekV4ModelId", () => {
  it("detects DeepSeek V4 flash", () => {
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/deepseek/deepseek-v4-flash")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("deepseek/deepseek-v4-flash")).toBe(true);
  });

  it("detects DeepSeek V4 pro", () => {
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/deepseek/deepseek-v4-pro")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("deepseek/deepseek-v4-pro")).toBe(true);
  });

  it("returns false for non-DeepSeek V4 models", () => {
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/deepseek/deepseek-v3")).toBe(false);
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/anthropic/claude-opus-4-8")).toBe(false);
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/deepseek-v4-flash")).toBe(false);
  });
});
