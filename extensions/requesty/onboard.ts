import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const REQUESTY_DEFAULT_MODEL_REF = "requesty/openai/gpt-4o";

export function applyRequestyProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[REQUESTY_DEFAULT_MODEL_REF] = {
    ...models[REQUESTY_DEFAULT_MODEL_REF],
    alias: models[REQUESTY_DEFAULT_MODEL_REF]?.alias ?? "Requesty",
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

export function applyRequestyConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyRequestyProviderConfig(cfg),
    REQUESTY_DEFAULT_MODEL_REF,
  );
}
