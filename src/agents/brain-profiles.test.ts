import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAIN_PROFILES,
  LEGACY_TIER_ROUTING,
  normalizeBrainTierConfigParts,
  resolveBrainProfileForAgent,
  resolveBrainProfileForMode,
} from "./brain-profiles.js";

describe("brain profile resolver", () => {
  it("uses legacy-compatible tier routing when no routing is configured", () => {
    const normalized = normalizeBrainTierConfigParts({});

    expect(normalized.tierRouting).toEqual(LEGACY_TIER_ROUTING);
    expect(resolveBrainProfileForMode(normalized, "economy")).toMatchObject({
      profileId: "legacy-anthropic-haiku",
      modelRef: "anthropic/claude-haiku-4-5-20251001",
      billing: "metered",
      commercialSafe: true,
    });
  });

  it("resolves configured routing and configured profile metadata", () => {
    const normalized = normalizeBrainTierConfigParts({
      tierRouting: {
        economy: "openai-api-cheap",
        baller: "openai-api-balanced",
        einstein: "openai-codex-subscription-best",
      },
      brainProfiles: DEFAULT_BRAIN_PROFILES,
    });

    expect(resolveBrainProfileForMode(normalized, "einstein")).toMatchObject({
      mode: "einstein",
      profileId: "openai-codex-subscription-best",
      modelRef: "openai-codex/gpt-5.5",
      provider: "openai-codex",
      auth: "oauth",
      billing: "subscription",
      commercialSafe: false,
      params: { reasoning_effort: "high" },
      fallbacks: [],
    });
  });

  it("blocks subscription to metered fallback unless explicitly allowed", () => {
    const normalized = normalizeBrainTierConfigParts({
      tierRouting: { einstein: "codex-with-metered-fallback" },
      brainProfiles: {
        "codex-with-metered-fallback": {
          id: "codex-with-metered-fallback",
          label: "Codex with API fallback",
          provider: "openai-codex",
          model: "gpt-5.5",
          auth: "oauth",
          billing: "subscription",
          modelRef: "openai-codex/gpt-5.5",
          fallbacks: ["openai-api-balanced"],
          allowMeteredFallback: false,
          commercialSafe: false,
        },
      },
    });

    const resolved = resolveBrainProfileForMode(normalized, "einstein");
    expect(resolved.fallbacks).toEqual([]);
    expect(resolved.blockedFallbacks).toEqual([
      {
        profileId: "openai-api-balanced",
        modelRef: "openai/gpt-5.4",
        reason: "subscription_to_metered_blocked",
      },
    ]);
  });

  it("allows subscription to metered fallback only when profile opts in", () => {
    const normalized = normalizeBrainTierConfigParts({
      tierRouting: { einstein: "codex-with-allowed-fallback" },
      brainProfiles: {
        "codex-with-allowed-fallback": {
          id: "codex-with-allowed-fallback",
          label: "Codex with API fallback",
          provider: "openai-codex",
          model: "gpt-5.5",
          auth: "oauth",
          billing: "subscription",
          modelRef: "openai-codex/gpt-5.5",
          fallbacks: ["openai-api-balanced"],
          allowMeteredFallback: true,
          commercialSafe: false,
        },
      },
    });

    expect(resolveBrainProfileForMode(normalized, "einstein").fallbacks).toEqual([
      "openai/gpt-5.4",
    ]);
  });

  it("keeps local profile metadata without requiring auth", () => {
    const normalized = normalizeBrainTierConfigParts({
      tierRouting: { economy: "local-economy" },
    });

    expect(resolveBrainProfileForMode(normalized, "economy")).toMatchObject({
      profileId: "local-economy",
      provider: "local-openai-compatible",
      auth: "none",
      billing: "local",
      modelRef: "local-openai-compatible/local-default",
      commercialSafe: true,
    });
  });

  it("uses agent override before global mode", () => {
    const normalized = normalizeBrainTierConfigParts({
      globalMode: "economy",
      agentOverrides: { quinn: "einstein" },
      tierRouting: {
        economy: "openai-api-cheap",
        einstein: "openai-codex-subscription-best",
      },
    });

    expect(resolveBrainProfileForAgent(normalized, "quinn")).toMatchObject({
      mode: "einstein",
      modelRef: "openai-codex/gpt-5.5",
    });
  });
});
