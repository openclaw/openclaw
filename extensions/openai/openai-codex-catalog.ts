import type { ModelProviderConfig } from "mullusi/plugin-sdk/provider-model-shared";

export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export function buildOpenAICodexProvider(): ModelProviderConfig {
  return {
    baseUrl: OPENAI_CODEX_BASE_URL,
    api: "openai-codex-responses",
    models: [],
  };
}
