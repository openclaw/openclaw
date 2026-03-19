import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_DEFAULT_MODEL_REF,
} from "openclaw/plugin-sdk/provider-models";
import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export { DEEPINFRA_BASE_URL, DEEPINFRA_DEFAULT_MODEL_REF };

export function applyDeepInfraProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[DEEPINFRA_DEFAULT_MODEL_REF] = {
    ...models[DEEPINFRA_DEFAULT_MODEL_REF],
    alias: models[DEEPINFRA_DEFAULT_MODEL_REF]?.alias ?? "DeepInfra",
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

export function applyDeepInfraConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyDeepInfraProviderConfig(cfg),
    DEEPINFRA_DEFAULT_MODEL_REF,
  );
}
