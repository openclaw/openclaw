import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";

const OPENAI_CODEX_API = "openai-codex-responses";

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  if (params.provider === "openai-codex" && !params.providerConfig.api) {
    return {
      ...params.providerConfig,
      api: OPENAI_CODEX_API,
    };
  }
  return params.providerConfig;
}
