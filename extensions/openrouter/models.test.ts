// Unit tests for the OpenRouter model id normalizers.
import { describe, expect, it } from "vitest";
import {
  isOpenRouterDeepSeekV4ModelId,
  isOpenRouterMistralModelId,
  normalizeOpenRouterApiModelId,
  normalizeOpenRouterModelId,
} from "./models.js";

describe("normalizeOpenRouterModelId", () => {
  it("strips the openrouter/ prefix from namespaced refs", () => {
    expect(normalizeOpenRouterModelId("openrouter/deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("strips the openrouter/ prefix from short refs", () => {
    expect(normalizeOpenRouterModelId("openrouter/deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("leaves non-openrouter refs unchanged", () => {
    expect(normalizeOpenRouterModelId("deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("lowercases input", () => {
    expect(normalizeOpenRouterModelId("OPENROUTER/Deepseek/Deepseek-V4-Flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("returns undefined for non-string input", () => {
    expect(normalizeOpenRouterModelId(undefined)).toBeUndefined();
    expect(normalizeOpenRouterModelId(42)).toBeUndefined();
  });
});

describe("normalizeOpenRouterApiModelId", () => {
  describe("native openrouter/ routes (preserved per #92611/#92627)", () => {
    it("preserves openrouter/auto as the native upstream slug", () => {
      expect(normalizeOpenRouterApiModelId("openrouter/auto")).toBe("openrouter/auto");
    });
  });

  describe("provider-qualified refs (existing #92627 behavior)", () => {
    it("strips the openrouter/ qualifier when the remainder is namespaced", () => {
      expect(normalizeOpenRouterApiModelId("openrouter/deepseek/deepseek-v4-flash")).toBe(
        "deepseek/deepseek-v4-flash",
      );
      expect(normalizeOpenRouterApiModelId("openrouter/moonshotai/kimi-k2.6")).toBe(
        "moonshotai/kimi-k2.6",
      );
    });
  });

  describe("short aliases (#95198 regression coverage)", () => {
    it("expands openrouter/deepseek-v4-flash to the namespaced upstream slug", () => {
      expect(normalizeOpenRouterApiModelId("openrouter/deepseek-v4-flash")).toBe(
        "deepseek/deepseek-v4-flash",
      );
    });

    it("expands openrouter/deepseek-v4-pro to the namespaced upstream slug", () => {
      expect(normalizeOpenRouterApiModelId("openrouter/deepseek-v4-pro")).toBe(
        "deepseek/deepseek-v4-pro",
      );
    });

    it("expands uppercase short aliases (input is case-normalized first)", () => {
      expect(normalizeOpenRouterApiModelId("OpenRouter/DeepSeek-V4-Flash")).toBe(
        "deepseek/deepseek-v4-flash",
      );
    });
  });

  describe("non-openrouter input", () => {
    it("leaves non-openrouter refs unchanged", () => {
      expect(normalizeOpenRouterApiModelId("deepseek/deepseek-v4-flash")).toBe(
        "deepseek/deepseek-v4-flash",
      );
      expect(normalizeOpenRouterApiModelId("anthropic/claude-opus-4.7")).toBe(
        "anthropic/claude-opus-4.7",
      );
    });

    it("returns undefined for non-string input", () => {
      expect(normalizeOpenRouterApiModelId(undefined)).toBeUndefined();
      expect(normalizeOpenRouterApiModelId(null)).toBeUndefined();
    });
  });
});

describe("isOpenRouterMistralModelId", () => {
  it("matches namespaced mistral refs", () => {
    expect(isOpenRouterMistralModelId("openrouter/mistralai/codestral-2508")).toBe(true);
    expect(isOpenRouterMistralModelId("mistralai/codestral-2508")).toBe(true);
  });

  it("does not match unrelated providers", () => {
    expect(isOpenRouterMistralModelId("openrouter/deepseek/deepseek-v4-flash")).toBe(false);
  });
});

describe("isOpenRouterDeepSeekV4ModelId", () => {
  it("matches namespaced DeepSeek V4 refs (both short and qualified inputs)", () => {
    expect(isOpenRouterDeepSeekV4ModelId("deepseek/deepseek-v4-flash")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/deepseek/deepseek-v4-pro")).toBe(true);
  });

  it("does not match DeepSeek V3 or unrelated refs", () => {
    expect(isOpenRouterDeepSeekV4ModelId("deepseek/deepseek-v3.1")).toBe(false);
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/auto")).toBe(false);
  });
});
