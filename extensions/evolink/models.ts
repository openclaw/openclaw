// EvoLink plugin module implements models behavior.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const EVOLINK_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "evolink",
  catalog: manifest.modelCatalog.providers.evolink,
});

export const EVOLINK_BASE_URL = EVOLINK_MANIFEST_PROVIDER.baseUrl;
export const EVOLINK_MODEL_CATALOG: ModelDefinitionConfig[] = EVOLINK_MANIFEST_PROVIDER.models;
export const EVOLINK_DEFAULT_MODEL_REF = "evolink/evolink/auto";

export function buildEvoLinkModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
