/**
 * C3 (Plan Mode 1.0 follow-up): tests for `evaluateAutoEnableForMatch`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { __resetCompiledPatternCacheForTests, evaluateAutoEnableForMatch } from "./auto-enable.js";

describe("evaluateAutoEnableForMatch", () => {
  beforeEach(() => {
    __resetCompiledPatternCacheForTests();
  });

  describe("empty / invalid inputs", () => {
    it("returns false for undefined modelId", () => {
      expect(evaluateAutoEnableForMatch(undefined, ["^gpt-5"])).toBe(false);
    });

    it("returns false for empty-string modelId", () => {
      expect(evaluateAutoEnableForMatch("", ["^gpt-5"])).toBe(false);
    });

    it("returns false for undefined patterns", () => {
      expect(evaluateAutoEnableForMatch("openai/gpt-5.4", undefined)).toBe(false);
    });

    it("returns false for empty patterns array", () => {
      expect(evaluateAutoEnableForMatch("openai/gpt-5.4", [])).toBe(false);
    });

    it("returns false when patterns is non-array (defensive)", () => {
      expect(
        evaluateAutoEnableForMatch("openai/gpt-5.4", "not-an-array" as unknown as string[]),
      ).toBe(false);
    });
  });

  describe("happy path", () => {
    it("matches GPT-5.x family via prefix regex", () => {
      expect(evaluateAutoEnableForMatch("openai/gpt-5.4", ["^openai/gpt-5\\."])).toBe(true);
      expect(evaluateAutoEnableForMatch("openai/gpt-5.1", ["^openai/gpt-5\\."])).toBe(true);
    });

    it("does NOT match GPT-4.x when pattern targets GPT-5.x", () => {
      expect(evaluateAutoEnableForMatch("openai/gpt-4.6", ["^openai/gpt-5\\."])).toBe(false);
    });

    it("matches any of multiple patterns (OR semantics)", () => {
      const patterns = ["^openai/gpt-5\\.", "^anthropic/claude-opus"];
      expect(evaluateAutoEnableForMatch("openai/gpt-5.4", patterns)).toBe(true);
      expect(evaluateAutoEnableForMatch("anthropic/claude-opus-4-7", patterns)).toBe(true);
      expect(evaluateAutoEnableForMatch("anthropic/claude-sonnet-4-6", patterns)).toBe(false);
    });

    it("substring regex (no anchors) matches anywhere in the model id", () => {
      expect(evaluateAutoEnableForMatch("synthetic/hf:moonshotai/Kimi-K2.5", ["Kimi"])).toBe(true);
    });
  });

  describe("malformed patterns (defense-in-depth)", () => {
    it("invalid regex is treated as non-matching (no crash)", () => {
      // Unclosed group — would throw on new RegExp().
      expect(evaluateAutoEnableForMatch("openai/gpt-5.4", ["(unclosed"])).toBe(false);
    });

    it("a valid pattern next to an invalid one still matches", () => {
      // Invalid pattern is silently skipped; valid one still fires.
      const patterns = ["(malformed", "^openai/gpt-5\\."];
      expect(evaluateAutoEnableForMatch("openai/gpt-5.4", patterns)).toBe(true);
    });

    it("empty-string pattern is skipped (not treated as match-all)", () => {
      // Empty regex `new RegExp("")` matches everything — defensive skip.
      expect(evaluateAutoEnableForMatch("openai/gpt-5.4", [""])).toBe(false);
    });

    it("non-string entries in patterns array are skipped", () => {
      expect(
        evaluateAutoEnableForMatch("openai/gpt-5.4", [
          null as unknown as string,
          "^openai/gpt-5\\.",
        ]),
      ).toBe(true);
    });
  });

  describe("compiled-regex cache (implicit)", () => {
    it("repeated calls with the same pattern do not re-compile (stable semantics)", () => {
      // This test doesn't introspect the cache directly (it's
      // module-private), but confirms that behavior is stable across
      // repeated calls with the same pattern + different models.
      const pattern = "^openai/gpt-5\\.";
      expect(evaluateAutoEnableForMatch("openai/gpt-5.4", [pattern])).toBe(true);
      expect(evaluateAutoEnableForMatch("openai/gpt-5.1", [pattern])).toBe(true);
      expect(evaluateAutoEnableForMatch("anthropic/claude-opus-4-7", [pattern])).toBe(false);
    });
  });
});
