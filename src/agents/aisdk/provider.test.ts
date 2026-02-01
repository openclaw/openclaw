import { describe, expect, it } from "vitest";
import {
  getDefaultConfig,
  parseModelRef,
  validateConfig,
  listAvailableProviders,
} from "./provider.js";

describe("AI SDK Provider", () => {
  describe("parseModelRef", () => {
    it("parses valid model reference", () => {
      const result = parseModelRef("anthropic/claude-sonnet-4");
      expect(result.providerId).toBe("anthropic");
      expect(result.modelId).toBe("claude-sonnet-4");
    });

    it("parses model ref with multiple slashes", () => {
      const result = parseModelRef("openai/gpt-4o/preview");
      expect(result.providerId).toBe("openai");
      expect(result.modelId).toBe("gpt-4o/preview");
    });

    it("throws on invalid model reference without slash", () => {
      expect(() => parseModelRef("claude-sonnet-4")).toThrow(
        'Invalid model reference "claude-sonnet-4"',
      );
    });
  });

  describe("getDefaultConfig", () => {
    it("returns gateway mode when AI_GATEWAY_API_KEY is set", () => {
      const original = process.env.AI_GATEWAY_API_KEY;
      try {
        process.env.AI_GATEWAY_API_KEY = "test-key";
        const config = getDefaultConfig();
        expect(config.mode).toBe("gateway");
        expect(config.gateway?.apiKey).toBe("test-key");
      } finally {
        if (original === undefined) {
          delete process.env.AI_GATEWAY_API_KEY;
        } else {
          process.env.AI_GATEWAY_API_KEY = original;
        }
      }
    });

    it("returns direct mode when no gateway key", () => {
      const original = process.env.AI_GATEWAY_API_KEY;
      try {
        delete process.env.AI_GATEWAY_API_KEY;
        const config = getDefaultConfig();
        expect(config.mode).toBe("direct");
      } finally {
        if (original !== undefined) {
          process.env.AI_GATEWAY_API_KEY = original;
        }
      }
    });

    it("includes default model reference", () => {
      const config = getDefaultConfig();
      expect(config.defaultModel).toBeDefined();
      expect(config.defaultModel).toContain("/");
    });
  });

  describe("validateConfig", () => {
    it("returns null for valid gateway config", () => {
      const result = validateConfig({
        mode: "gateway",
        gateway: { apiKey: "test-key" },
      });
      expect(result).toBeNull();
    });

    it("returns error for gateway mode without key", () => {
      const original = process.env.AI_GATEWAY_API_KEY;
      try {
        delete process.env.AI_GATEWAY_API_KEY;
        const result = validateConfig({
          mode: "gateway",
        });
        expect(result).toContain("AI Gateway");
      } finally {
        if (original !== undefined) {
          process.env.AI_GATEWAY_API_KEY = original;
        }
      }
    });

    it("returns error for direct mode without any provider keys", () => {
      // Clear all provider env vars temporarily
      const saved: Record<string, string | undefined> = {};
      const providerVars = [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GOOGLE_API_KEY",
        "GROQ_API_KEY",
        "MISTRAL_API_KEY",
        "XAI_API_KEY",
        "OPENROUTER_API_KEY",
        "AZURE_API_KEY",
      ];
      for (const v of providerVars) {
        saved[v] = process.env[v];
        delete process.env[v];
      }
      try {
        const result = validateConfig({
          mode: "direct",
          providers: {},
        });
        expect(result).toContain("at least one provider");
      } finally {
        for (const v of providerVars) {
          if (saved[v] !== undefined) {
            process.env[v] = saved[v];
          }
        }
      }
    });
  });

  describe("listAvailableProviders", () => {
    it("returns all providers for gateway mode", () => {
      const providers = listAvailableProviders({ mode: "gateway" });
      expect(providers).toContain("anthropic");
      expect(providers).toContain("openai");
      expect(providers).toContain("google");
    });

    it("returns only providers with keys for direct mode", () => {
      const original = process.env.ANTHROPIC_API_KEY;
      try {
        process.env.ANTHROPIC_API_KEY = "test-key";
        const providers = listAvailableProviders({
          mode: "direct",
          providers: {},
        });
        expect(providers).toContain("anthropic");
      } finally {
        if (original === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = original;
        }
      }
    });
  });
});
