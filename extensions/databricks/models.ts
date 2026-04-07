import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const DATABRICKS_BASE_URL = "https://<workspace>.cloud.databricks.com/serving-endpoints";

export const DATABRICKS_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "databricks-meta-llama-3-1-70b-instruct",
    name: "Llama 3.1 70B Instruct (Databricks)",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: {
      input: 0.0,
      output: 0.0,
      cacheRead: 0.0,
      cacheWrite: 0.0,
    },
  },
  {
    id: "databricks-dbrx-instruct",
    name: "DBRX Instruct (Databricks)",
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 4096,
    cost: {
      input: 0.0,
      output: 0.0,
      cacheRead: 0.0,
      cacheWrite: 0.0,
    },
  }
];

export function buildDatabricksModelDefinition(
  model: (typeof DATABRICKS_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}
