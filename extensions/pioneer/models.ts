// Pioneer plugin module implements model catalog behavior.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PIONEER_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "pioneer",
  catalog: manifest.modelCatalog.providers.pioneer,
});

export const PIONEER_BASE_URL = PIONEER_MANIFEST_PROVIDER.baseUrl;
export const PIONEER_DEFAULT_MODEL_ID = "pioneer/auto";
export const PIONEER_DEFAULT_MODEL_REF = PIONEER_DEFAULT_MODEL_ID;
export const PIONEER_MODEL_CATALOG: ModelDefinitionConfig[] = PIONEER_MANIFEST_PROVIDER.models;

export function buildPioneerModelDefinition(
  model: (typeof PIONEER_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
