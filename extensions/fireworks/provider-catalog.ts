// Fireworks provider module implements model/runtime integration.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const FIREWORKS_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "fireworks",
  catalog: manifest.modelCatalog.providers.fireworks,
});

export const FIREWORKS_BASE_URL = FIREWORKS_MANIFEST_PROVIDER.baseUrl;
export const FIREWORKS_DEFAULT_MODEL_ID = "accounts/fireworks/routers/kimi-k2p5-turbo";
export const FIREWORKS_K2_6_MODEL_ID = "accounts/fireworks/models/kimi-k2p6";
export const FIREWORKS_DEEPSEEK_V4_MODEL_ID = "accounts/fireworks/models/deepseek-v4-pro";
export const FIREWORKS_MINIMAX_M3_MODEL_ID = "accounts/fireworks/models/minimax-m3";
export const FIREWORKS_GLM_5_1_MODEL_ID = "accounts/fireworks/models/glm-5p1";
export const FIREWORKS_GPT_OSS_120B_MODEL_ID = "accounts/fireworks/models/gpt-oss-120b";

function requireFireworksManifestModel(id: string): ModelDefinitionConfig {
  const model = FIREWORKS_MANIFEST_PROVIDER.models.find((entry) => entry.id === id);
  if (!model) {
    throw new Error(`Missing Fireworks modelCatalog row ${id}`);
  }
  return model;
}

const FIREWORKS_DEFAULT_MODEL = requireFireworksManifestModel(FIREWORKS_DEFAULT_MODEL_ID);
const FIREWORKS_K2_6_MODEL = requireFireworksManifestModel(FIREWORKS_K2_6_MODEL_ID);

export const FIREWORKS_DEFAULT_CONTEXT_WINDOW = FIREWORKS_DEFAULT_MODEL.contextWindow;
export const FIREWORKS_DEFAULT_MAX_TOKENS = FIREWORKS_DEFAULT_MODEL.maxTokens;
export const FIREWORKS_K2_6_CONTEXT_WINDOW = FIREWORKS_K2_6_MODEL.contextWindow;
export const FIREWORKS_K2_6_MAX_TOKENS = FIREWORKS_K2_6_MODEL.maxTokens;

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
