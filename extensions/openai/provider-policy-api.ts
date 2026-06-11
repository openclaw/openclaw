// Openai API module exposes the plugin public contract.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return params.providerConfig;
}

export function resolveThinkingProfile(params: {
  provider: string;
  api?: string;
  modelId: string;
}) {
  const api = params.api?.trim().toLowerCase();
  switch (params.provider.trim().toLowerCase()) {
    case "openai":
      return resolveUnifiedOpenAIThinkingProfile(params.modelId);
    default:
      if (api === "openai-responses") {
        return resolveUnifiedOpenAIThinkingProfile(params.modelId);
      }
      return null;
  }
}
