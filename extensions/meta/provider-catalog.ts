import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const META_BASE_URL = manifest.modelCatalog.providers.meta.baseUrl;
export const META_MODEL_CATALOG = manifest.modelCatalog.providers.meta.models;

export function buildMetaCatalogModels(): ModelDefinitionConfig[] {
  return buildMetaProvider().models;
}

/** Builds the Meta OpenAI-compatible model provider config. */
export function buildMetaProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "meta",
    catalog: manifest.modelCatalog.providers.meta,
  });
}
