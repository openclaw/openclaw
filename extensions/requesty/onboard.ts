// Requesty setup module handles plugin onboarding behavior.
import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { REQUESTY_DEFAULT_MODEL_ID } from "./provider-catalog.js";

export const REQUESTY_DEFAULT_MODEL_REF = `requesty/${REQUESTY_DEFAULT_MODEL_ID}`;

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
