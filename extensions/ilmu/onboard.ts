import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildIlmuModelDefinition, ILMU_BASE_URL, ILMU_MODEL_CATALOG } from "./api.js";

export const ILMU_DEFAULT_MODEL_REF = "ilmu/nemo-super";

export function applyIlmuProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[ILMU_DEFAULT_MODEL_REF] = {
    ...models[ILMU_DEFAULT_MODEL_REF],
    alias: models[ILMU_DEFAULT_MODEL_REF]?.alias ?? "ILMU",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "ilmu",
    api: "openai-completions",
    baseUrl: ILMU_BASE_URL,
    catalogModels: ILMU_MODEL_CATALOG.map(buildIlmuModelDefinition),
  });
}

export function applyIlmuConfig(cfg: OpenClawConfig): OpenClawConfig {
  const withProvider = applyIlmuProviderConfig(cfg);
  // Seed thinking-on defaults when the user picks ILMU. Use `??` so an
  // explicit user choice (including "off") is never clobbered by re-running
  // the wizard.
  const withDefaults: OpenClawConfig = {
    ...withProvider,
    agents: {
      ...withProvider.agents,
      defaults: {
        ...withProvider.agents?.defaults,
        thinkingDefault: withProvider.agents?.defaults?.thinkingDefault ?? "medium",
      },
    },
  };
  return applyAgentDefaultModelPrimary(withDefaults, ILMU_DEFAULT_MODEL_REF);
}
