import {
  applyProviderConfigWithModelCatalogPreset,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildAvianProvider, AVIAN_DEFAULT_MODEL_ID } from "./provider-catalog.js";

export const AVIAN_DEFAULT_MODEL_REF = `avian/${AVIAN_DEFAULT_MODEL_ID}`;

function applyAvianPreset(cfg: OpenClawConfig, primaryModelRef?: string): OpenClawConfig {
  const provider = buildAvianProvider();
  return applyProviderConfigWithModelCatalogPreset(cfg, {
    providerId: "avian",
    api: "openai-completions",
    baseUrl: provider.baseUrl ?? "",
    catalogModels: provider.models ?? [],
    aliases: [{ modelRef: AVIAN_DEFAULT_MODEL_REF, alias: "Avian" }],
    primaryModelRef,
  });
}

export function applyAvianProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAvianPreset(cfg);
}

export function applyAvianConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAvianPreset(cfg, AVIAN_DEFAULT_MODEL_REF);
}
