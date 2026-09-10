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

// DeepInfra serves every model family over one OpenAI-compatible endpoint, so
// core's endpoint-based attribution resolves all of them to thinkingFormat
// "openai". DeepSeek models emit DSML tool-call markup (`<|DSML|tool_calls>`)
// and reasoning_content that core only strips/recovers when thinkingFormat is
// "deepseek"; without this tag the markup leaks into user channels and the tool
// calls are lost. Declare the dialect per family like opencode-go does for Qwen
// (extensions/opencode-go/provider-catalog.ts).
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
