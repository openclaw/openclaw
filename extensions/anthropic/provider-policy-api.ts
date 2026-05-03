/**
 * Anthropic Provider Policy API
 * Note: This file must remain zero-dependency to pass OpenClaw bundled extension checks.
 * We avoid top-level imports from the plugin-sdk to stay within the extension boundary.
 */

import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfigForProvider,
} from "./config-defaults.js";

export function normalizeConfig(params: { provider: string; providerConfig: any }) {
  return normalizeAnthropicProviderConfigForProvider(params);
}

export function applyConfigDefaults(params: any) {
  return applyAnthropicConfigDefaults(params);
}

/**
 * Resolves thinking profiles for Claude models.
 * Logic is inlined to avoid external SDK dependencies in the bundled artifact.
 */
export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  const p = params.provider?.trim().toLowerCase();
  if (p !== "anthropic" && p !== "claude-cli") return null;

  const id = params.modelId || "";

  // Claude Opus 4.7: Extended Reasoning (max, xhigh, adaptive)
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

  // Claude Sonnet 4.6: Standard Reasoning + Adaptive
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

  // Haiku / Legacy / Default: Base Reasoning
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