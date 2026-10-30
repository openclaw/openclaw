import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";

// Keep DeepInfra's /v1/openai endpoint intact: generic completions normalization
// would append another /v1 and break inference. This policy bypasses that fallback.
export function normalizeConfig(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  return params.providerConfig;
}
