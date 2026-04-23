import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { WAVESPEED_BASE_URL, WAVESPEED_DEFAULT_MODEL_REF } from "./models.js";
import { buildWaveSpeedCatalogModels } from "./provider-catalog.js";

const wavespeedPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: WAVESPEED_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "wavespeed",
    api: "openai-completions",
    baseUrl: WAVESPEED_BASE_URL,
    catalogModels: buildWaveSpeedCatalogModels(),
    aliases: [{ modelRef: WAVESPEED_DEFAULT_MODEL_REF, alias: "WaveSpeed" }],
  }),
});

export function applyWaveSpeedProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return wavespeedPresetAppliers.applyProviderConfig(cfg);
}

export function applyWaveSpeedConfig(cfg: OpenClawConfig): OpenClawConfig {
  return wavespeedPresetAppliers.applyConfig(cfg);
}
