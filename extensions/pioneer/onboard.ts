// Pioneer setup module handles plugin onboarding behavior.
import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { PIONEER_DEFAULT_MODEL_REF } from "./models.js";

function applyPioneerProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  // Use a provider wildcard so all live-discovered Pioneer models are visible
  // in the model picker without enumerating them in config. The plugin catalog
  // provides the full model list at runtime via live discovery.
  const models = { ...cfg.agents?.defaults?.models, "pioneer/*": {} };
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

export function applyPioneerConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyPioneerProviderConfig(cfg), PIONEER_DEFAULT_MODEL_REF);
}
