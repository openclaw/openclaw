import {
  buildVeniceModelDefinition,
  VENICE_BASE_URL,
  VENICE_DEFAULT_MODEL_REF,
  VENICE_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";
import {
  applyProviderConfigWithModelCatalogPreset,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export { VENICE_DEFAULT_MODEL_REF };

function applyVenicePreset(cfg: OpenClawConfig, primaryModelRef?: string): OpenClawConfig {
  return applyProviderConfigWithModelCatalogPreset(cfg, {
    providerId: "venice",
    api: "openai-completions",
    baseUrl: VENICE_BASE_URL,
    catalogModels: VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition),
    aliases: [{ modelRef: VENICE_DEFAULT_MODEL_REF, alias: "Kimi K2.5" }],
    primaryModelRef,
  });
}

export function applyVeniceProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyVenicePreset(cfg);
}

export function applyVeniceConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyVenicePreset(cfg, VENICE_DEFAULT_MODEL_REF);
}
