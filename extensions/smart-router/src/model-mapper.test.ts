import { describe, expect, it } from "vitest";
import { resolveModelForTier } from "./model-mapper.js";
import type { SmartRouterConfig } from "./types.js";

describe("resolveModelForTier", () => {
  const fullConfig: SmartRouterConfig = {
    tiers: {
      simple: { provider: "openai", model: "gpt-4.1-mini" },
      medium: { provider: "anthropic", model: "claude-sonnet-4-5" },
      complex: { provider: "anthropic", model: "claude-opus-4-6" },
      reasoning: { provider: "openai", model: "o3" },
    },
  };

  it("returns the configured mapping for each tier", () => {
    expect(resolveModelForTier("simple", fullConfig)).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    expect(resolveModelForTier("medium", fullConfig)).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(resolveModelForTier("complex", fullConfig)).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(resolveModelForTier("reasoning", fullConfig)).toEqual({
      provider: "openai",
      model: "o3",
    });
  });

  it("returns null when tiers config is undefined", () => {
    expect(resolveModelForTier("simple", {})).toBeNull();
  });

  it("returns null when specific tier is not configured", () => {
    const partial: SmartRouterConfig = {
      tiers: {
        simple: { provider: "openai", model: "gpt-4.1-mini" },
      },
    };
    expect(resolveModelForTier("complex", partial)).toBeNull();
  });

  it("returns null for empty config", () => {
    expect(resolveModelForTier("medium", { tiers: {} })).toBeNull();
  });
});
