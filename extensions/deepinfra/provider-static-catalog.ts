import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-model-metadata";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { DEEPINFRA_BASE_URL } from "./media-models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const DEEPINFRA_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "deepinfra",
  catalog: manifest.modelCatalog.providers.deepinfra,
});

const DEEPINFRA_DEFAULT_MODEL_ID = "deepseek-ai/DeepSeek-V4-Flash";
export const DEEPINFRA_DEFAULT_MODEL_REF = `deepinfra/${DEEPINFRA_DEFAULT_MODEL_ID}`;

export const DEEPINFRA_MODEL_CATALOG: ModelDefinitionConfig[] = DEEPINFRA_MANIFEST_PROVIDER.models;

// DeepInfra's shared OpenAI endpoint cannot identify DeepSeek's DSML dialect;
// declare it per family so replay strips markup and recovers tool calls.
function resolveDeepInfraThinkingFormat(modelId: string | undefined): "deepseek" | undefined {
  const vendor = (modelId ?? "").toLowerCase().split("/")[0];
  return vendor === "deepseek-ai" ? "deepseek" : undefined;
}

export function buildDeepInfraModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  const thinkingFormat = model.compat?.thinkingFormat ?? resolveDeepInfraThinkingFormat(model.id);
  return {
    ...model,
    compat: {
      ...model.compat,
      supportsUsageInStreaming: model.compat?.supportsUsageInStreaming ?? true,
      ...(thinkingFormat ? { thinkingFormat } : {}),
    },
  };
}

export function buildStaticDeepInfraProvider(): ModelProviderConfig {
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models: DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition),
  };
}
