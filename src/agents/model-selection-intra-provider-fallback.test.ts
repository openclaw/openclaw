import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveModelFallbackAvailability } from "./model-selection-config.js";

describe("resolveModelFallbackAvailability explicit model intent", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: {
          primary: "google/default-model",
        },
      },
    },
  };

  it.each([undefined, "user"] as const)("keeps an alternate model strict (source=%s)", (source) => {
    const availability = resolveModelFallbackAvailability({
      cfg,
      agentId: "main",
      hasSessionModelOverride: true,
      modelOverrideSource: source,
      selectedModel: { provider: "google", model: "alternate-model" },
    });

    expect(availability).toEqual({
      kind: "disabled_by_model_override",
    });
  });

  it("still disables fallback when the user selected a model on a different provider entirely", () => {
    const availability = resolveModelFallbackAvailability({
      cfg,
      agentId: "main",
      hasSessionModelOverride: true,
      selectedModel: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });

    expect(availability).toEqual({
      kind: "disabled_by_model_override",
    });
  });

  it("preserves normal configured fallbacks when the user selected the primary model", () => {
    const availability = resolveModelFallbackAvailability({
      cfg,
      agentId: "main",
      hasSessionModelOverride: true,
      selectedModel: { provider: "google", model: "default-model" },
    });

    expect(availability).toEqual({
      kind: "none_configured",
      source: "inherited",
    });
  });
});
