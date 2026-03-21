import {
  buildSyntheticModelDefinition,
  type ModelProviderConfig,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";

export function buildSyntheticProvider(): ModelProviderConfig {
  return {
    baseUrl: SYNTHETIC_BASE_URL,
    api: "anthropic-messages",
    models: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
  };
}
