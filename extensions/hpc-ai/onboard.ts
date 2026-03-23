import {
  buildHpcAiModelDefinition,
  HPC_AI_BASE_URL,
  HPC_AI_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const HPC_AI_DEFAULT_MODEL_REF = "hpc-ai/minimax/minimax-m2.5";

const hpcAiPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: HPC_AI_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "hpc-ai",
    api: "openai-completions",
    baseUrl: HPC_AI_BASE_URL,
    catalogModels: HPC_AI_MODEL_CATALOG.map(buildHpcAiModelDefinition),
    aliases: [
      { modelRef: HPC_AI_DEFAULT_MODEL_REF, alias: "MiniMax M2.5" },
      { modelRef: "hpc-ai/moonshotai/kimi-k2.5", alias: "Kimi K2.5" },
    ],
  }),
});

export function applyHpcAiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return hpcAiPresetAppliers.applyProviderConfig(cfg);
}

export function applyHpcAiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return hpcAiPresetAppliers.applyConfig(cfg);
}
