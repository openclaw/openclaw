import {
  buildManifestModelProviderConfig,
  readManifestProviderDefaultModelRef,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const FIREWORKS_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "fireworks",
  catalog: manifest.modelCatalog.providers.fireworks,
});
export const FIREWORKS_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(
  manifest,
  "fireworks",
)!;

export const FIREWORKS_BASE_URL = FIREWORKS_MANIFEST_PROVIDER.baseUrl;
export const FIREWORKS_DEFAULT_MODEL_ID = FIREWORKS_DEFAULT_MODEL_REF.slice("fireworks/".length);

const FIREWORKS_DEFAULT_MODEL = FIREWORKS_MANIFEST_PROVIDER.models.find(
  (model) => model.id === FIREWORKS_DEFAULT_MODEL_ID,
);
if (!FIREWORKS_DEFAULT_MODEL) {
  throw new Error(`Missing Fireworks modelCatalog row ${FIREWORKS_DEFAULT_MODEL_ID}`);
}

export const FIREWORKS_DEFAULT_CONTEXT_WINDOW = FIREWORKS_DEFAULT_MODEL.contextWindow;
export const FIREWORKS_DEFAULT_MAX_TOKENS = FIREWORKS_DEFAULT_MODEL.maxTokens;

export function isFireworksCatalogModelId(modelId: string): boolean {
  return FIREWORKS_MANIFEST_PROVIDER.models.some((model) => model.id === modelId);
}

export function buildFireworksCatalogModels(): ModelDefinitionConfig[] {
  return FIREWORKS_MANIFEST_PROVIDER.models.map((model) => structuredClone(model));
}

export function buildFireworksProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "fireworks",
    catalog: manifest.modelCatalog.providers.fireworks,
  });
}
