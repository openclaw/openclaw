import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { applyConfigDefaults, normalizeConfig, resolveThinkingProfile } from "./provider-policy-api.js";

function createModel(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

describe("anthropic provider policy public artifact", () => {
  describe("config normalization", () => {
    it("normalizes Anthropic provider config", () => {
      expect(
        normalizeConfig({
          provider: "anthropic",
          providerConfig: {
            baseUrl: "https://api.anthropic.com",
            models: [createModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
          },
        }),
      ).toMatchObject({
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      });
    });

    it("normalizes Claude CLI provider config", () => {
      expect(
        normalizeConfig({
          provider: "claude-cli",
          providerConfig: {
            baseUrl: "https://api.anthropic.com",
            models: [createModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
          },
        }),
      ).toMatchObject({
        api: "anthropic-messages",
      });
    });

    it("does not normalize non-Anthropic provider config", () => {
      const providerConfig = {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        models: [createModel("gpt-5.4", "GPT-5.4")],
      };

      expect(
        normalizeConfig({
          provider: "openai-codex",
          providerConfig,
        }),
      ).toBe(providerConfig);
    });
  });

  describe("config defaults", () => {
    it("applies Anthropic API-key defaults without loading the full provider plugin", () => {
      const nextConfig = applyConfigDefaults({
        config: {
          auth: {
            profiles: {
              "anthropic:default": {
                provider: "anthropic",
                mode: "api_key",
              },
            },
            order: { anthropic: ["anthropic:default"] },
          },
          agents: {
            defaults: {},
          },
        },
        env: {},
      });

      expect(nextConfig.agents?.defaults?.contextPruning).toMatchObject({
        mode: "cache-ttl",
        ttl: "1h",
      });
    });
  });

  describe("thinking profile resolution", () => {
    it("resolves the extended thinking profile for Claude Opus 4.7", () => {
      const profile = resolveThinkingProfile({
        provider: "anthropic",
        modelId: "claude-opus-4-7",
      });

      expect(profile).toBeDefined();
      const ids = profile?.levels.map((l) => l.id);
      
      // These are the levels that were previously missing in the bundled artifact
      expect(ids).toContain("max");
      expect(ids).toContain("xhigh");
      expect(ids).toContain("adaptive");
    });

    it("resolves correct levels for Claude Sonnet 4.6 (no max/xhigh)", () => {
      const profile = resolveThinkingProfile({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      });

      const ids = profile?.levels.map((l) => l.id);
      expect(ids).toContain("adaptive");
      expect(ids).not.toContain("max");
      expect(ids).not.toContain("xhigh");
    });

    it("handles the 'claude-cli' provider alias", () => {
      const profile = resolveThinkingProfile({
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
      });
      expect(profile?.levels.map(l => l.id)).toContain("max");
    });

    it("returns null for non-Anthropic providers to avoid profile hijacking", () => {
      const profile = resolveThinkingProfile({
        provider: "openai",
        modelId: "gpt-5.4",
      });
      expect(profile).toBeNull();
    });
  });
});