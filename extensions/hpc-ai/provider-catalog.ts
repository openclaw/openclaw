import {
  buildHpcAiModelDefinition,
  type ModelProviderConfig,
  HPC_AI_BASE_URL,
  HPC_AI_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";

export function buildHpcAiProvider(): ModelProviderConfig {
  return {
    baseUrl: HPC_AI_BASE_URL,
    api: "openai-completions",
    models: HPC_AI_MODEL_CATALOG.map(buildHpcAiModelDefinition),
  };
}
