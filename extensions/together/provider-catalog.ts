import {
  buildTogetherModelDefinition,
  type ModelProviderConfig,
  TOGETHER_BASE_URL,
  TOGETHER_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";

export function buildTogetherProvider(): ModelProviderConfig {
  return {
    baseUrl: TOGETHER_BASE_URL,
    api: "openai-completions",
    models: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition),
  };
}
