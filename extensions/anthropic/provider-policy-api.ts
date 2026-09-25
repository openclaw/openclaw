/**
 * Provider-policy API for Anthropic and Claude CLI. Core calls this lightweight
 * path for config defaults and thinking profiles.
 */
import {
  resolveClaudeModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeThinkingProfile,
} from "openclaw/plugin-sdk/claude-model-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { CLAUDE_CLI_OFF_THINKING_PROFILE, CLAUDE_CLI_PROFILE_ID } from "./cli-constants.js";
import { normalizeAnthropicProviderConfigForProvider } from "./config-defaults.js";
export { applyAnthropicConfigDefaults as applyConfigDefaults } from "./config-defaults.js";

export const normalizeConfig = normalizeAnthropicProviderConfigForProvider<ModelProviderConfig>;

export { resolveFastModeSupport } from "./fast-mode-policy.js";

/** Profile ids that native Claude auth has retired from OpenClaw ownership. */
export const deprecatedProfileIds = [CLAUDE_CLI_PROFILE_ID] as const;

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
  const provider = params.provider.trim().toLowerCase();
  switch (provider) {
    case "anthropic":
    case "claude-cli":
      if (provider === "claude-cli" && resolveClaudeMythos5ModelIdentity({ id: contractModelId })) {
        return CLAUDE_CLI_OFF_THINKING_PROFILE;
      }
      // Claude Code exposes Fable's native effort ladder. Keep subscription-
      // backed and API-backed Fable routes on one model contract.
      return resolveClaudeThinkingProfile(contractModelId, undefined, {
        includeNativeMax: true,
      });
    default:
      return null;
  }
}
