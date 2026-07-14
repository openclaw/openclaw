/**
 * Provider-policy API for Anthropic and Claude CLI. Core calls this lightweight
 * path for config defaults and thinking profiles.
 */
import {
  resolveClaudeModelIdentity,
  resolveClaudeThinkingProfile,
} from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfigForProvider,
} from "./config-defaults.js";

/** Normalize Anthropic provider config without importing runtime registration. */
export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return normalizeAnthropicProviderConfigForProvider(params);
}

/** Apply Anthropic config defaults through the provider-policy seam. */
export function applyConfigDefaults(params: Parameters<typeof applyAnthropicConfigDefaults>[0]) {
  return applyAnthropicConfigDefaults(params);
}

/** Resolve Claude thinking profile for Anthropic or Claude CLI providers. */
export function resolveThinkingProfile(params: {
  provider: string;
  modelId: string;
  params?: Record<string, unknown>;
}) {
  const contractModelId = resolveClaudeModelIdentity({
    id: params.modelId,
    params: params.params,
  });
  switch (params.provider.trim().toLowerCase()) {
    case "anthropic":
    // Claude Code honors --effort for mandatory-adaptive Claude 5 models
    // (verified on Claude Code 2.1.202), so the CLI backend gets the same
    // native effort ladder as the direct Anthropic API.
    case "claude-cli":
      return resolveClaudeThinkingProfile(contractModelId, undefined, {
        includeNativeMax: true,
      });
    default:
      return null;
  }
}
