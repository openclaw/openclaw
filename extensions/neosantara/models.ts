// Neosantara plugin module implements models behavior.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const NEOSANTARA_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "neosantara",
  catalog: manifest.modelCatalog.providers.neosantara,
});

export const NEOSANTARA_BASE_URL = NEOSANTARA_MANIFEST_PROVIDER.baseUrl;

export const NEOSANTARA_MODEL_CATALOG: ModelDefinitionConfig[] =
  NEOSANTARA_MANIFEST_PROVIDER.models;

export function buildNeosantaraModelDefinition(
  model: (typeof NEOSANTARA_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: model.api ?? "openai-completions",
    input: [...model.input],
    cost: { ...model.cost },
  };
}
