import type { ModelProviderConfig, OpenAIPayloadModifier } from "openclaw/plugin-sdk/provider-model-shared";
import { buildDatabricksModelDefinition, DATABRICKS_BASE_URL, DATABRICKS_MODEL_CATALOG } from "./api.js";

const databricksPayloadModifier: OpenAIPayloadModifier = (payload) => {
  const modified = { ...payload };
  if ("store" in modified) {
    delete modified.store;
  }
  // Remove non-standard properties databricks backend might reject
  if (modified.tools && Array.isArray(modified.tools)) {
    // You can implement deeper tool signature modification if needed for databricks
  }
  return modified;
};

export function buildDatabricksProvider(): ModelProviderConfig {
  return {
    baseUrl: DATABRICKS_BASE_URL,
    api: "openai-completions",
    models: DATABRICKS_MODEL_CATALOG.map(buildDatabricksModelDefinition),
    openAiPayloadModifier: databricksPayloadModifier,
  };
}
