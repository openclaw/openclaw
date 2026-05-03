import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { resolveClaudeThinkingProfile } from "../../plugin-sdk/provider-model-shared.js";
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
 * Resolves the thinking profile for Anthropic models without requiring 
 * the full plugin runtime to be loaded.
 */
export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  // Only handle anthropic or its alias claude-cli
  const p = params.provider.trim().toLowerCase();
  if (p !== "anthropic" && p !== "claude-cli") return null;
  
  return resolveClaudeThinkingProfile(params.modelId) ?? null;
}