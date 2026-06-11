// AIgateway plugin module implements models behavior.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const AIGATEWAY_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "aigateway",
  catalog: manifest.modelCatalog.providers.aigateway,
});

export const AIGATEWAY_BASE_URL = AIGATEWAY_MANIFEST_PROVIDER.baseUrl;
export const AIGATEWAY_MODEL_CATALOG: ModelDefinitionConfig[] = AIGATEWAY_MANIFEST_PROVIDER.models;
export const AIGATEWAY_DEFAULT_MODEL_REF = "aigateway/openai/gpt-5.5";

export function buildAigatewayModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
