import { describe, expect, it } from "vitest";
import { resolveCacheRetention } from "./cache-retention.js";

describe("resolveCacheRetention", () => {
  // ── Anthropic ──

  describe("anthropic provider", () => {
    it("defaults to 'short' when no config", () => {
      expect(resolveCacheRetention(undefined, "anthropic")).toBe("short");
      expect(resolveCacheRetention({}, "anthropic")).toBe("short");
    });

    it("honors explicit cacheRetention", () => {
      expect(resolveCacheRetention({ cacheRetention: "none" }, "anthropic")).toBe("none");
      expect(resolveCacheRetention({ cacheRetention: "short" }, "anthropic")).toBe("short");
      expect(resolveCacheRetention({ cacheRetention: "long" }, "anthropic")).toBe("long");
    });

    it("maps legacy cacheControlTtl '5m' → 'short'", () => {
      expect(resolveCacheRetention({ cacheControlTtl: "5m" }, "anthropic")).toBe("short");
    });

    it("maps legacy cacheControlTtl '1h' → 'long'", () => {
      expect(resolveCacheRetention({ cacheControlTtl: "1h" }, "anthropic")).toBe("long");
    });

    it("prefers cacheRetention over legacy cacheControlTtl", () => {
      expect(
        resolveCacheRetention({ cacheRetention: "long", cacheControlTtl: "5m" }, "anthropic"),
      ).toBe("long");
    });
  });

  // ── Bedrock ──

  describe("amazon-bedrock provider", () => {
    it("returns undefined when no config (explicit-only)", () => {
      expect(resolveCacheRetention(undefined, "amazon-bedrock")).toBeUndefined();
      expect(resolveCacheRetention({}, "amazon-bedrock")).toBeUndefined();
    });

    it("honors explicit cacheRetention", () => {
      expect(resolveCacheRetention({ cacheRetention: "short" }, "amazon-bedrock")).toBe("short");
      expect(resolveCacheRetention({ cacheRetention: "long" }, "amazon-bedrock")).toBe("long");
      expect(resolveCacheRetention({ cacheRetention: "none" }, "amazon-bedrock")).toBe("none");
    });

    it("honors legacy cacheControlTtl", () => {
      expect(resolveCacheRetention({ cacheControlTtl: "5m" }, "amazon-bedrock")).toBe("short");
      expect(resolveCacheRetention({ cacheControlTtl: "1h" }, "amazon-bedrock")).toBe("long");
    });
  });

  // ── OpenAI ──

  describe("openai provider", () => {
    it("returns undefined when no config (no implicit default)", () => {
      expect(resolveCacheRetention(undefined, "openai")).toBeUndefined();
      expect(resolveCacheRetention({}, "openai")).toBeUndefined();
    });

    it("passes through explicit cacheRetention", () => {
      expect(resolveCacheRetention({ cacheRetention: "short" }, "openai")).toBe("short");
      expect(resolveCacheRetention({ cacheRetention: "long" }, "openai")).toBe("long");
      expect(resolveCacheRetention({ cacheRetention: "none" }, "openai")).toBe("none");
    });

    it("ignores legacy cacheControlTtl (not an Anthropic-family provider)", () => {
      expect(resolveCacheRetention({ cacheControlTtl: "5m" }, "openai")).toBeUndefined();
    });
  });

  // ── OpenAI Codex ──

  describe("openai-codex provider", () => {
    it("returns undefined when no config (no implicit default)", () => {
      expect(resolveCacheRetention(undefined, "openai-codex")).toBeUndefined();
      expect(resolveCacheRetention({}, "openai-codex")).toBeUndefined();
    });

    it("passes through explicit cacheRetention", () => {
      expect(resolveCacheRetention({ cacheRetention: "short" }, "openai-codex")).toBe("short");
      expect(resolveCacheRetention({ cacheRetention: "long" }, "openai-codex")).toBe("long");
      expect(resolveCacheRetention({ cacheRetention: "none" }, "openai-codex")).toBe("none");
    });

    it("ignores legacy cacheControlTtl", () => {
      expect(resolveCacheRetention({ cacheControlTtl: "1h" }, "openai-codex")).toBeUndefined();
    });
  });

  // ── Unsupported providers ──

  describe("unsupported providers", () => {
    const unsupported = ["google", "openrouter", "ollama", "deepseek", "mistral"];

    for (const provider of unsupported) {
      it(`returns undefined for '${provider}' even with explicit config`, () => {
        expect(resolveCacheRetention(undefined, provider)).toBeUndefined();
        expect(resolveCacheRetention({ cacheRetention: "long" }, provider)).toBeUndefined();
        expect(resolveCacheRetention({ cacheControlTtl: "5m" }, provider)).toBeUndefined();
      });
    }
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("ignores invalid cacheRetention values", () => {
      expect(resolveCacheRetention({ cacheRetention: "forever" }, "anthropic")).toBe("short");
      expect(resolveCacheRetention({ cacheRetention: 42 }, "anthropic")).toBe("short");
      expect(resolveCacheRetention({ cacheRetention: true }, "openai")).toBeUndefined();
    });

    it("ignores invalid legacy cacheControlTtl values", () => {
      expect(resolveCacheRetention({ cacheControlTtl: "10m" }, "anthropic")).toBe("short");
    });
  });
});
