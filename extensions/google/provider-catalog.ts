import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-model-metadata";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const GOOGLE_VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
export const GOOGLE_GEMINI_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "google",
  catalog: manifest.modelCatalog.providers.google,
});
const GOOGLE_GEMINI_TEXT_MODELS = GOOGLE_GEMINI_MANIFEST_PROVIDER.models;
export const GOOGLE_GEMINI_TEXT_MODEL_BY_ID = new Map(
  GOOGLE_GEMINI_TEXT_MODELS.map((model) => [model.id, model]),
);
export const GOOGLE_GEMINI_TEXT_MODEL_IDS: ReadonlySet<string> = new Set(
  GOOGLE_GEMINI_TEXT_MODEL_BY_ID.keys(),
);

function requireGoogleManifestCost(): NonNullable<ModelDefinitionConfig["cost"]> {
  const cost = GOOGLE_GEMINI_TEXT_MODELS[0]?.cost;
  if (!cost) {
    throw new Error("Google manifest model catalog must declare a cost for its first model");
  }
  return cost;
}

export const GOOGLE_GEMINI_COST = requireGoogleManifestCost();

export function buildGoogleStaticCatalogProvider(): ModelProviderConfig {
  return {
    ...GOOGLE_GEMINI_MANIFEST_PROVIDER,
    models: GOOGLE_GEMINI_TEXT_MODELS.map((model) => ({
      ...model,
      input: [...model.input, "video"],
    })),
  };
}

export function buildGoogleVertexStaticCatalogProvider(): ModelProviderConfig {
  return {
    baseUrl: GOOGLE_VERTEX_BASE_URL,
    api: "google-vertex",
    models: GOOGLE_GEMINI_TEXT_MODELS,
  };
}
