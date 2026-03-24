import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const NOVITA_DEFAULT_MODEL_REF = "novita/moonshotai/kimi-k2.5";

export function applyNovitaProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[NOVITA_DEFAULT_MODEL_REF] = {
    ...models[NOVITA_DEFAULT_MODEL_REF],
    alias: models[NOVITA_DEFAULT_MODEL_REF]?.alias ?? "Novita AI",
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
  };
}

export function applyNovitaConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyNovitaProviderConfig(cfg), NOVITA_DEFAULT_MODEL_REF);
}
