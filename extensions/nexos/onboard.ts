import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildNexosModelDefinition, NEXOS_BASE_URL, NEXOS_MODEL_CATALOG } from "./api.js";

export const NEXOS_DEFAULT_MODEL_REF = "nexos/Claude Opus 4.6";

const nexosPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: NEXOS_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "nexos",
    api: "openai-completions",
    baseUrl: NEXOS_BASE_URL,
    catalogModels: NEXOS_MODEL_CATALOG.map(buildNexosModelDefinition),
    aliases: [{ modelRef: NEXOS_DEFAULT_MODEL_REF, alias: "Nexos AI" }],
  }),
});

export function applyNexosProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return nexosPresetAppliers.applyProviderConfig(cfg);
}

export function applyNexosConfig(cfg: OpenClawConfig): OpenClawConfig {
  return nexosPresetAppliers.applyConfig(cfg);
}
