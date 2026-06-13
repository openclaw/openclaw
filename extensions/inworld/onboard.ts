import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { INWORLD_DEFAULT_MODEL_REF } from "./models.js";

export { INWORLD_DEFAULT_MODEL_REF };

export function applyInworldProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[INWORLD_DEFAULT_MODEL_REF] = {
    ...models[INWORLD_DEFAULT_MODEL_REF],
    alias: models[INWORLD_DEFAULT_MODEL_REF]?.alias ?? "Inworld",
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

export function applyInworldConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyInworldProviderConfig(cfg), INWORLD_DEFAULT_MODEL_REF);
}
