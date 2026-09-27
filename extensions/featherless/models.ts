// Featherless model catalog helpers derive their values from the plugin manifest.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelCompatConfig,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export function buildFeatherlessProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "featherless",
    catalog: manifest.modelCatalog.providers.featherless,
  });
}

const FEATHERLESS_MANIFEST_PROVIDER = buildFeatherlessProvider();

export const FEATHERLESS_BASE_URL = FEATHERLESS_MANIFEST_PROVIDER.baseUrl;
export const FEATHERLESS_DEFAULT_MODEL_ID = "Qwen/Qwen3-32B";
export const FEATHERLESS_DEFAULT_MODEL_REF = `featherless/${FEATHERLESS_DEFAULT_MODEL_ID}` as const;
export const FEATHERLESS_DYNAMIC_CONTEXT_WINDOW = 4096;
export const FEATHERLESS_DYNAMIC_MAX_TOKENS = 1024;

const FEATHERLESS_DEFAULT_MODEL = FEATHERLESS_MANIFEST_PROVIDER.models.find(
  (model) => model.id === FEATHERLESS_DEFAULT_MODEL_ID,
);
if (!FEATHERLESS_DEFAULT_MODEL) {
  throw new Error(`Missing Featherless modelCatalog row ${FEATHERLESS_DEFAULT_MODEL_ID}`);
}

export const FEATHERLESS_DEFAULT_CONTEXT_WINDOW = FEATHERLESS_DEFAULT_MODEL.contextWindow;
export const FEATHERLESS_DEFAULT_MAX_TOKENS = FEATHERLESS_DEFAULT_MODEL.maxTokens;
export const FEATHERLESS_DYNAMIC_COMPAT: ModelCompatConfig = {
  ...FEATHERLESS_DEFAULT_MODEL.compat,
  thinkingFormat: "openai",
};

export function isFeatherlessCatalogModelId(modelId: string): boolean {
  return FEATHERLESS_MANIFEST_PROVIDER.models.some((model) => model.id === modelId);
}

export function buildFeatherlessCatalogModels(): ModelDefinitionConfig[] {
  return FEATHERLESS_MANIFEST_PROVIDER.models.map((model) => structuredClone(model));
}
