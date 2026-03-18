import {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_DEFAULT_MODEL_REF,
  SYNTHETIC_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";
import {
  applyProviderConfigWithModelCatalogPreset,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export { SYNTHETIC_DEFAULT_MODEL_REF };

function applySyntheticPreset(cfg: OpenClawConfig, primaryModelRef?: string): OpenClawConfig {
  return applyProviderConfigWithModelCatalogPreset(cfg, {
    providerId: "synthetic",
    api: "anthropic-messages",
    baseUrl: SYNTHETIC_BASE_URL,
    catalogModels: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
    aliases: [{ modelRef: SYNTHETIC_DEFAULT_MODEL_REF, alias: "MiniMax M2.5" }],
    primaryModelRef,
  });
}

export function applySyntheticProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applySyntheticPreset(cfg);
}

export function applySyntheticConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applySyntheticPreset(cfg, SYNTHETIC_DEFAULT_MODEL_REF);
}
