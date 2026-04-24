import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyProviderConfigWithModelCatalogPreset,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  buildZaiModelDefinition,
  isZaiCodingBaseUrl,
  resolveZaiBaseUrl,
  resolveZaiNonCodingBaseUrl,
  ZAI_DEFAULT_MODEL_ID,
} from "./model-definitions.js";

export const ZAI_DEFAULT_MODEL_REF = `zai/${ZAI_DEFAULT_MODEL_ID}`;

const ZAI_CATALOG_IDS = [
  "glm-5.1",
  "glm-5",
  "glm-5-turbo",
  "glm-5v-turbo",
  "glm-4.7",
  "glm-4.7-flash",
  "glm-4.7-flashx",
  "glm-4.6",
  "glm-4.6v",
  "glm-4.5",
  "glm-4.5-air",
  "glm-4.5-flash",
  "glm-4.5v",
] as const;

function buildZaiCatalogModels(providerBaseUrl: string): ModelDefinitionConfig[] {
  // When the provider is configured to a Coding Plan endpoint, vision models
  // must target the matching non-coding host; carry a per-model baseUrl so
  // the image tool stays functional without overriding the text-model path.
  const visionBaseUrl = isZaiCodingBaseUrl(providerBaseUrl)
    ? resolveZaiNonCodingBaseUrl(providerBaseUrl)
    : undefined;
  const models: ModelDefinitionConfig[] = [];
  for (const id of ZAI_CATALOG_IDS) {
    const model = buildZaiModelDefinition({ id });
    if (visionBaseUrl && model.input.includes("image")) {
      model.baseUrl = visionBaseUrl;
    }
    models.push(model);
  }
  return models;
}

function resolveZaiPresetBaseUrl(cfg: OpenClawConfig, endpoint?: string): string {
  const existingProvider = cfg.models?.providers?.zai;
  const existingBaseUrl = normalizeOptionalString(existingProvider?.baseUrl) ?? "";
  return endpoint ? resolveZaiBaseUrl(endpoint) : existingBaseUrl || resolveZaiBaseUrl();
}

function syncZaiVisionBaseUrls(cfg: OpenClawConfig, providerBaseUrl: string): OpenClawConfig {
  // The shared preset preserves existing model entries by id, so previously
  // onboarded vision models keep a stale baseUrl when the endpoint changes
  // (e.g. coding-global -> coding-cn or coding-* -> global). Canonicalize the
  // vision entries here: coding endpoints get the matching non-coding host,
  // non-coding endpoints drop any prior override.
  const zai = cfg.models?.providers?.zai;
  if (!zai || !Array.isArray(zai.models)) {
    return cfg;
  }
  const visionBaseUrl = isZaiCodingBaseUrl(providerBaseUrl)
    ? resolveZaiNonCodingBaseUrl(providerBaseUrl)
    : undefined;
  const patched = zai.models.map((model) => {
    if (!model.input?.includes("image")) {
      return model;
    }
    if (visionBaseUrl) {
      return model.baseUrl === visionBaseUrl ? model : { ...model, baseUrl: visionBaseUrl };
    }
    if (model.baseUrl === undefined) {
      return model;
    }
    const { baseUrl: _drop, ...rest } = model;
    return rest;
  });
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: { ...cfg.models?.providers, zai: { ...zai, models: patched } },
    },
  };
}

function applyZaiPreset(
  cfg: OpenClawConfig,
  params?: { endpoint?: string; modelId?: string },
  primaryModelRef?: string,
): OpenClawConfig {
  const modelId = normalizeOptionalString(params?.modelId) ?? ZAI_DEFAULT_MODEL_ID;
  const modelRef = `zai/${modelId}`;
  const baseUrl = resolveZaiPresetBaseUrl(cfg, params?.endpoint);
  const next = applyProviderConfigWithModelCatalogPreset(cfg, {
    providerId: "zai",
    api: "openai-completions",
    baseUrl,
    catalogModels: buildZaiCatalogModels(baseUrl),
    aliases: [{ modelRef, alias: "GLM" }],
    primaryModelRef,
  });
  return syncZaiVisionBaseUrls(next, baseUrl);
}

export function applyZaiProviderConfig(
  cfg: OpenClawConfig,
  params?: { endpoint?: string; modelId?: string },
): OpenClawConfig {
  return applyZaiPreset(cfg, params);
}

export function applyZaiConfig(
  cfg: OpenClawConfig,
  params?: { endpoint?: string; modelId?: string },
): OpenClawConfig {
  const modelId = normalizeOptionalString(params?.modelId) ?? ZAI_DEFAULT_MODEL_ID;
  const modelRef = modelId === ZAI_DEFAULT_MODEL_ID ? ZAI_DEFAULT_MODEL_REF : `zai/${modelId}`;
  return applyZaiPreset(cfg, params, modelRef);
}
