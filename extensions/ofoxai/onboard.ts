import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const OFOXAI_DEFAULT_MODEL_REF = "ofoxai/gpt-4o-mini";

export function applyOfoxaiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[OFOXAI_DEFAULT_MODEL_REF] = {
    ...models[OFOXAI_DEFAULT_MODEL_REF],
    alias: models[OFOXAI_DEFAULT_MODEL_REF]?.alias ?? "OfoxAI",
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

export function applyOfoxaiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyOfoxaiProviderConfig(cfg),
    OFOXAI_DEFAULT_MODEL_REF,
  );
}
