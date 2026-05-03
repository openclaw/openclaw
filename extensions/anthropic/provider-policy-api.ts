import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfigForProvider,
} from "./config-defaults.js";

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return normalizeAnthropicProviderConfigForProvider(params);
}

export function applyConfigDefaults(params: Parameters<typeof applyAnthropicConfigDefaults>[0]) {
  return applyAnthropicConfigDefaults(params);
}

/**
 * Resolves the thinking profile for Anthropic models.
 * Logic is inlined to satisfy zero-dependency rules for bundled extensions.
 */
export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  const p = params.provider.trim().toLowerCase();
  if (p !== "anthropic" && p !== "claude-cli") return null;

  const id = params.modelId;

  // Extended profile for Claude Opus 4.7
  if (id.includes("claude-opus-4-7") || id.includes("claude-opus-4.7")) {
    return {
      levels: [
        { id: "off", name: "Off" },
        { id: "minimal", name: "Minimal" },
        { id: "low", name: "Low" },
        { id: "medium", name: "Medium" },
        { id: "adaptive", name: "Adaptive" },
        { id: "high", name: "High" },
        { id: "xhigh", name: "Extra High" },
        { id: "max", name: "Maximum" },
      ],
      default: "off",
    };
  }

  // Profile for Sonnet 4.6 (includes adaptive)
  if (id.includes("4-6") || id.includes("4.6")) {
    return {
      levels: [
        { id: "off", name: "Off" },
        { id: "minimal", name: "Minimal" },
        { id: "low", name: "Low" },
        { id: "medium", name: "Medium" },
        { id: "adaptive", name: "Adaptive" },
        { id: "high", name: "High" },
      ],
      default: "off",
    };
  }

  // Standard profile for Haiku and legacy models
  return {
    levels: [
      { id: "off", name: "Off" },
      { id: "minimal", name: "Minimal" },
      { id: "low", name: "Low" },
      { id: "medium", name: "Medium" },
      { id: "high", name: "High" },
    ],
    default: "off",
  };
}