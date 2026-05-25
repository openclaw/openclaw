import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const EDENAI_DEFAULT_MODEL_REF = "edenai/anthropic/claude-sonnet-4-6";

export function applyEdenaiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[EDENAI_DEFAULT_MODEL_REF] = {
    ...models[EDENAI_DEFAULT_MODEL_REF],
    alias: models[EDENAI_DEFAULT_MODEL_REF]?.alias ?? "Eden AI",
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

export function applyEdenaiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyEdenaiProviderConfig(cfg), EDENAI_DEFAULT_MODEL_REF);
}
