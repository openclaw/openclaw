import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PLEUMROUTER_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "pleumrouter",
  catalog: manifest.modelCatalog.providers.pleumrouter,
});

export const PLEUMROUTER_BASE_URL = PLEUMROUTER_MANIFEST_PROVIDER.baseUrl;
export const PLEUMROUTER_MODEL_CATALOG: ModelDefinitionConfig[] = PLEUMROUTER_MANIFEST_PROVIDER.models;
export const PLEUMROUTER_DEFAULT_MODEL_REF = "pleumrouter/deepseek-v4-pro";

export function buildPleumrouterModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
