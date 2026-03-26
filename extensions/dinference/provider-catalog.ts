import {
  buildDinferenceModelDefinition,
  type ModelProviderConfig,
  DINFERENCE_BASE_URL,
  DINFERENCE_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";

export function buildDinferenceProvider(): ModelProviderConfig {
  return {
    baseUrl: DINFERENCE_BASE_URL,
    api: "openai-completions",
    models: DINFERENCE_MODEL_CATALOG.map(buildDinferenceModelDefinition),
  };
}
