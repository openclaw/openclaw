import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const POLLINATIONS_DEFAULT_MODEL_REF = "pollinations/openai";

export function applyPollinationsProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[POLLINATIONS_DEFAULT_MODEL_REF] = {
    ...models[POLLINATIONS_DEFAULT_MODEL_REF],
    alias: models[POLLINATIONS_DEFAULT_MODEL_REF]?.alias ?? "Pollinations",
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

export function applyPollinationsConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyPollinationsProviderConfig(cfg),
    POLLINATIONS_DEFAULT_MODEL_REF,
  );
}
