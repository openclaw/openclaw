import {
  buildSambanovaModelDefinition,
  type ModelProviderConfig,
  SAMBANOVA_BASE_URL,
  SAMBANOVA_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";

export function buildSambanovaProvider(): ModelProviderConfig {
  return {
    baseUrl: SAMBANOVA_BASE_URL,
    api: "openai-completions",
    models: SAMBANOVA_MODEL_CATALOG.map(buildSambanovaModelDefinition),
  };
}
