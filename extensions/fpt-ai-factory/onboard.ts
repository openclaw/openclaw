import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildFptAiFactoryModelDefinition,
  FPT_AI_FACTORY_BASE_URL,
  FPT_AI_FACTORY_DEFAULT_MODEL_REF,
  FPT_AI_FACTORY_FALLBACK_MODEL_CATALOG,
} from "./models.js";

const fptAiFactoryPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: FPT_AI_FACTORY_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "fpt-ai-factory",
    api: "openai-completions" as const,
    baseUrl: FPT_AI_FACTORY_BASE_URL,
    catalogModels: FPT_AI_FACTORY_FALLBACK_MODEL_CATALOG.map(buildFptAiFactoryModelDefinition),
    aliases: [{ modelRef: FPT_AI_FACTORY_DEFAULT_MODEL_REF, alias: "FPT AI Factory" }],
  }),
});

export { FPT_AI_FACTORY_DEFAULT_MODEL_REF };

export function applyFptAiFactoryProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return fptAiFactoryPresetAppliers.applyProviderConfig(cfg);
}

export function applyFptAiFactoryConfig(cfg: OpenClawConfig): OpenClawConfig {
  return fptAiFactoryPresetAppliers.applyConfig(cfg);
}
