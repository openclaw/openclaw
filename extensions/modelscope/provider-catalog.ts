import {
  buildModelScopeModelDefinition,
  discoverModelScopeModels,
  MODELSCOPE_BASE_URL,
  MODELSCOPE_MODEL_CATALOG,
} from "../../src/agents/modelscope-models.js";
import type { ModelProviderConfig } from "../../src/config/types.models.js";

export async function buildModelScopeProvider(
  discoveryApiKey?: string,
): Promise<ModelProviderConfig> {
  const resolvedSecret = discoveryApiKey?.trim() ?? "";
  const models =
    resolvedSecret !== ""
      ? await discoverModelScopeModels(resolvedSecret)
      : MODELSCOPE_MODEL_CATALOG.map(buildModelScopeModelDefinition);
  return {
    baseUrl: MODELSCOPE_BASE_URL,
    api: "openai-completions",
    models,
  };
}
