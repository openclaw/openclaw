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

// Dynamic ids of the cataloged reasoning families inherit their manifest row's
// compat. Fireworks' baseUrl classifies as a proxy-like endpoint, so detected
// transport defaults disable reasoning_effort — without explicit compat the
// advertised thinking profiles would never encode on the request.
function fireworksManifestCompat(id: string): ModelDefinitionConfig["compat"] {
  // Deep-clone like cloneFireworksCatalogModel: dynamic models must not share
  // nested compat references with the manifest singleton.
  return structuredClone(requireFireworksManifestModel(id).compat ?? {});
}
export const FIREWORKS_DEEPSEEK_V4_COMPAT = fireworksManifestCompat(
  "accounts/fireworks/models/deepseek-v4-pro",
);
export const FIREWORKS_MINIMAX_M2_COMPAT = fireworksManifestCompat(
  "accounts/fireworks/models/minimax-m2p7",
);
export const FIREWORKS_GLM_COMPAT = fireworksManifestCompat("accounts/fireworks/models/glm-5p1");
export const FIREWORKS_GPT_OSS_COMPAT = fireworksManifestCompat(
  "accounts/fireworks/models/gpt-oss-120b",
);

function cloneFireworksCatalogModel(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
    // compat carries nested arrays/maps; deep-clone so consumers cannot
    // mutate the manifest-derived singletons.
    ...(model.compat ? { compat: structuredClone(model.compat) } : {}),
  };
}

export function buildFireworksCatalogModels(): ModelDefinitionConfig[] {
  return FIREWORKS_MANIFEST_PROVIDER.models.map(cloneFireworksCatalogModel);
}

export function buildFireworksProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "fireworks",
    catalog: manifest.modelCatalog.providers.fireworks,
  });
}
