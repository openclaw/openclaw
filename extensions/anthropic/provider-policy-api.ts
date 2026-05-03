import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
// FIX: Use the SDK alias or the correct relative path for the extension SDK
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

export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  const p = params.provider.trim().toLowerCase();
  if (p !== "anthropic" && p !== "claude-cli") return null;
  
  return resolveClaudeThinkingProfile(params.modelId) ?? null;
}