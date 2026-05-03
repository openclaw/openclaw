import { describe, expect, it } from "vitest";
import { 
  applyConfigDefaults, 
  normalizeConfig, 
  resolveThinkingProfile 
} from "./provider-policy-api.js";

describe("anthropic provider policy public artifact", () => {
  describe("config normalization", () => {
    it("handles basic normalization through local helpers", () => {
      const config = {
        provider: "anthropic",
        providerConfig: { baseUrl: "https://api.anthropic.com", models: [] }
      };
      const result = normalizeConfig(config);
      expect(result).toHaveProperty("api", "anthropic-messages");
    });
  });

  describe("thinking profile resolution", () => {
    it("resolves the extended thinking profile for Claude Opus 4.7", () => {
      const profile = resolveThinkingProfile({
        provider: "anthropic",
        modelId: "claude-opus-4-7",
      });
      
      expect(profile).toBeDefined();
      const ids = profile?.levels.map((l: any) => l.id);
      
      // Verify Opus 4.7 specific levels
      expect(ids).toContain("max");
      expect(ids).toContain("xhigh");
      expect(ids).toContain("adaptive");
      expect(ids).toContain("high");
    });

    it("resolves the standard thinking profile for Claude Sonnet 4.6", () => {
      const profile = resolveThinkingProfile({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      });
      
      const ids = profile?.levels.map((l: any) => l.id);
      expect(ids).toContain("adaptive");
      expect(ids).toContain("high");
      expect(ids).not.toContain("max");
      expect(ids).not.toContain("xhigh");
    });

    it("resolves the minimal profile for Haiku", () => {
      const profile = resolveThinkingProfile({
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      });
      
      const ids = profile?.levels.map((l: any) => l.id);
      expect(ids).toContain("high");
      expect(ids).not.toContain("adaptive");
      expect(ids).not.toContain("max");
    });

    it("handles the 'claude-cli' provider alias", () => {
      const profile = resolveThinkingProfile({
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
      });
      expect(profile?.levels.map((l: any) => l.id)).toContain("max");
    });

    it("returns null for non-anthropic providers", () => {
      expect(resolveThinkingProfile({ provider: "openai", modelId: "gpt-4" })).toBeNull();
    });
  });
});