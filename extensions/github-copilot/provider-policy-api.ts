// Github Copilot API module exposes the plugin public contract.
import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/core";
import {
  resolveCopilotExtendedThinkingLevels,
  resolveCopilotTransportApi,
} from "./model-metadata.js";

export function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext) {
  if (context.provider.trim().toLowerCase() !== "github-copilot") {
    return null;
  }
  const extendedLevels = resolveCopilotExtendedThinkingLevels(context.modelId, context.compat);
  const isClaudeModel = resolveCopilotTransportApi(context.modelId) === "anthropic-messages";

  return {
    levels: [
      { id: "off" as const },
      { id: "minimal" as const },
      { id: "low" as const },
      { id: "medium" as const },
      { id: "high" as const },
      ...extendedLevels.map((id) => ({ id })),
    ],
    // Copilot's /models endpoint does not expose OpenAI-style reasoning_effort
    // for Anthropic-backed models, so discovery marks Claude models
    // reasoning:false and the shared resolver collapses this profile to
    // off-only. Claude models do support reasoning, so preserve the declared
    // levels for them; non-Claude Copilot models without reasoning_effort stay
    // off-only. Mirrors the active provider hook in index.ts. See #99240.
    ...(isClaudeModel ? { preserveWhenCatalogReasoningFalse: true } : {}),
  };
}
