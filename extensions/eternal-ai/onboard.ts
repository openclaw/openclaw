import {
  applyProviderConfigWithModelCatalogPreset,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildEternalAiProvider,
  ETERNAL_AI_BASE_URL,
  ETERNAL_AI_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

export const ETERNAL_AI_DEFAULT_MODEL_REF = `eternal-ai/${ETERNAL_AI_DEFAULT_MODEL_ID}`;

function applyEternalAiPreset(cfg: OpenClawConfig, primaryModelRef?: string): OpenClawConfig {
  const provider = buildEternalAiProvider();
  return applyProviderConfigWithModelCatalogPreset(cfg, {
    providerId: "eternal-ai",
    api: "openai-completions",
    baseUrl: ETERNAL_AI_BASE_URL,
    catalogModels: provider.models,
    aliases: [{ modelRef: ETERNAL_AI_DEFAULT_MODEL_REF, alias: "Eternal AI" }],
    primaryModelRef,
  });
}

export function applyEternalAiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyEternalAiPreset(cfg);
}

export function applyEternalAiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyEternalAiPreset(cfg, ETERNAL_AI_DEFAULT_MODEL_REF);
}
