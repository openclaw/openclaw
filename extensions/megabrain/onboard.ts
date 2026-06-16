// MegaBrain setup module handles plugin onboarding behavior.
import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { MEGABRAIN_DEFAULT_MODEL_ID, MEGABRAIN_PROVIDER_ID } from "./models.js";

export const MEGABRAIN_DEFAULT_MODEL_REF = `${MEGABRAIN_PROVIDER_ID}/${MEGABRAIN_DEFAULT_MODEL_ID}`;

function applyMegaBrainProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[MEGABRAIN_DEFAULT_MODEL_REF] = {
    ...models[MEGABRAIN_DEFAULT_MODEL_REF],
    alias: models[MEGABRAIN_DEFAULT_MODEL_REF]?.alias ?? "MegaBrain",
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

export function applyMegaBrainConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyMegaBrainProviderConfig(cfg),
    MEGABRAIN_DEFAULT_MODEL_REF,
  );
}
