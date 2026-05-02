import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { buildArceeModelDefinition, ARCEE_MODEL_CATALOG } from "./models.js";
import {
  ARCEE_BASE_URL,
  normalizeArceeOpenRouterBaseUrl,
  OPENROUTER_BASE_URL,
  toArceeOpenRouterModelId,
} from "./provider-policy.js";

export { normalizeArceeOpenRouterBaseUrl, OPENROUTER_BASE_URL, toArceeOpenRouterModelId };

export function buildArceeCatalogModels(): NonNullable<ModelProviderConfig["models"]> {
  return ARCEE_MODEL_CATALOG.map(buildArceeModelDefinition);
}

export function buildArceeOpenRouterCatalogModels(): NonNullable<ModelProviderConfig["models"]> {
  return buildArceeCatalogModels().map((model) =>
    Object.assign({}, model, { id: toArceeOpenRouterModelId(model.id) }),
  );
}

export function buildArceeProvider(): ModelProviderConfig {
  return {
    baseUrl: ARCEE_BASE_URL,
    api: "openai-completions",
    models: buildArceeCatalogModels(),
  };
}

export function buildArceeOpenRouterProvider(): ModelProviderConfig {
  return {
    baseUrl: OPENROUTER_BASE_URL,
    api: "openai-completions",
    models: buildArceeOpenRouterCatalogModels(),
  };
}
