import { XAI_BASE_URL, XAI_DEFAULT_MODEL_ID } from "openclaw/plugin-sdk/provider-models";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModels,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildXaiCatalogModels } from "./model-definitions.js";

export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;

function applyXaiProviderConfigWithApi(
  cfg: OpenClawConfig,
  api: "openai-completions" | "openai-responses",
): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[XAI_DEFAULT_MODEL_REF] = {
    ...models[XAI_DEFAULT_MODEL_REF],
    alias: models[XAI_DEFAULT_MODEL_REF]?.alias ?? "Grok",
  };

  return applyProviderConfigWithDefaultModels(cfg, {
    agentModels: models,
    providerId: "xai",
    api,
    baseUrl: XAI_BASE_URL,
    defaultModels: buildXaiCatalogModels(),
    defaultModelId: XAI_DEFAULT_MODEL_ID,
  });
}

export function applyXaiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyXaiProviderConfigWithApi(cfg, "openai-completions");
}

export function applyXaiResponsesApiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyXaiProviderConfigWithApi(cfg, "openai-responses");
}

export function applyXaiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyXaiProviderConfig(cfg), XAI_DEFAULT_MODEL_REF);
}
