import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { SERVEPATH_DEFAULT_MODEL_ALIAS, SERVEPATH_DEFAULT_MODEL_REF } from "./defaults.js";

export { SERVEPATH_DEFAULT_MODEL_REF } from "./defaults.js";

export function applyServepathProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[SERVEPATH_DEFAULT_MODEL_REF] = {
    ...models[SERVEPATH_DEFAULT_MODEL_REF],
    alias: models[SERVEPATH_DEFAULT_MODEL_REF]?.alias ?? SERVEPATH_DEFAULT_MODEL_ALIAS,
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

export function applyServepathConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyServepathProviderConfig(cfg),
    SERVEPATH_DEFAULT_MODEL_REF,
  );
}
