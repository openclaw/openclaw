import { describe, expect, it } from "vitest";
import {
  MODEL_DEFAULT_SENTINEL,
  isModelDefaultSentinel,
  normalizeStoredModelOverride,
} from "./model-default-sentinel.js";

describe("model-default-sentinel", () => {
  describe("MODEL_DEFAULT_SENTINEL", () => {
    it("is the literal string @default", () => {
      expect(MODEL_DEFAULT_SENTINEL).toBe("@default");
    });
  });

  describe("isModelDefaultSentinel", () => {
    it("returns true for the bare sentinel", () => {
      expect(isModelDefaultSentinel("@default")).toBe(true);
    });

    it("returns true for the sentinel with surrounding whitespace", () => {
      expect(isModelDefaultSentinel("  @default  ")).toBe(true);
      expect(isModelDefaultSentinel("\t@default\n")).toBe(true);
    });

    it("returns false for a real model identifier", () => {
      expect(isModelDefaultSentinel("openai-codex/gpt-5.5")).toBe(false);
      expect(isModelDefaultSentinel("anthropic/claude-opus-4-6")).toBe(false);
      expect(isModelDefaultSentinel("gpt-5.5")).toBe(false);
    });

    it("returns false for sentinel-adjacent but non-matching strings", () => {
      expect(isModelDefaultSentinel("default")).toBe(false);
      expect(isModelDefaultSentinel("@latest")).toBe(false);
      expect(isModelDefaultSentinel("@defaults")).toBe(false);
      expect(isModelDefaultSentinel("@default-2")).toBe(false);
      expect(isModelDefaultSentinel("provider/@default")).toBe(false);
    });

    it("returns false for non-string values", () => {
      expect(isModelDefaultSentinel(undefined)).toBe(false);
      expect(isModelDefaultSentinel(null)).toBe(false);
      expect(isModelDefaultSentinel(0)).toBe(false);
      expect(isModelDefaultSentinel({})).toBe(false);
      expect(isModelDefaultSentinel([])).toBe(false);
    });

    it("is case-sensitive (sentinel is exactly @default)", () => {
      expect(isModelDefaultSentinel("@DEFAULT")).toBe(false);
      expect(isModelDefaultSentinel("@Default")).toBe(false);
    });
  });

  describe("normalizeStoredModelOverride", () => {
    it("returns undefined for the sentinel", () => {
      expect(normalizeStoredModelOverride("@default")).toBeUndefined();
      expect(normalizeStoredModelOverride("  @default  ")).toBeUndefined();
    });

    it("returns undefined for empty / whitespace / falsy values", () => {
      expect(normalizeStoredModelOverride("")).toBeUndefined();
      expect(normalizeStoredModelOverride("   ")).toBeUndefined();
      expect(normalizeStoredModelOverride(undefined)).toBeUndefined();
      expect(normalizeStoredModelOverride(null)).toBeUndefined();
    });

    it("returns the trimmed string for real model identifiers", () => {
      expect(normalizeStoredModelOverride("openai-codex/gpt-5.5")).toBe("openai-codex/gpt-5.5");
      expect(normalizeStoredModelOverride("  gpt-5.5  ")).toBe("gpt-5.5");
    });

    it("preserves model-list-shaped objects via the shared normalizer", () => {
      expect(normalizeStoredModelOverride({ primary: "anthropic/claude-opus-4-6" })).toBe(
        "anthropic/claude-opus-4-6",
      );
    });

    it("returns undefined for objects whose primary is the sentinel", () => {
      // Sentinel detection runs both before and after the underlying
      // normalizer, so object-shape overrides like `{ primary: "@default" }`
      // — which can appear in `agentConfigOverride.subagents.model` — also
      // fall through to the live default instead of leaking the literal
      // sentinel string into model resolution.
      expect(normalizeStoredModelOverride({ primary: "@default" })).toBeUndefined();
      expect(normalizeStoredModelOverride({ primary: "  @default  " })).toBeUndefined();
    });

    it("preserves real models embedded in objects with sentinel-shaped fallbacks", () => {
      // Only `primary` is read by normalizeModelSelection; if the object's
      // primary is a real model, we return it even if other fields contain
      // the sentinel.
      expect(
        normalizeStoredModelOverride({
          primary: "anthropic/claude-opus-4-6",
          fallbacks: ["@default"],
        }),
      ).toBe("anthropic/claude-opus-4-6");
    });
  });
});
