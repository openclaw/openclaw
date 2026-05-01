import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const OPENPATHS_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "openpaths",
  catalog: manifest.modelCatalog.providers.openpaths,
});

export const OPENPATHS_BASE_URL = OPENPATHS_MANIFEST_PROVIDER.baseUrl;
export const OPENPATHS_MODEL_CATALOG: ModelDefinitionConfig[] = OPENPATHS_MANIFEST_PROVIDER.models;

export function buildOpenPathsModelDefinition(
  model: (typeof OPENPATHS_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}

export function isOpenPathsAutoModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return normalized === "auto" || normalized === "autothink" || normalized.startsWith("auto-");
}
