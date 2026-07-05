// Deepinfra setup module handles plugin onboarding behavior.
import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { DEEPINFRA_BASE_URL, DEEPINFRA_DEFAULT_MODEL_REF } from "./provider-models.js";

export { DEEPINFRA_BASE_URL, DEEPINFRA_DEFAULT_MODEL_REF };

<<<<<<< HEAD
export function applyDeepInfraConfig(
=======
export function applyDeepInfraProviderConfig(
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  cfg: OpenClawConfig,
  modelRef: string = DEEPINFRA_DEFAULT_MODEL_REF,
): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[modelRef] = {
    ...models[modelRef],
    alias: models[modelRef]?.alias ?? "DeepInfra",
  };

<<<<<<< HEAD
  return applyAgentDefaultModelPrimary({
=======
  return {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
<<<<<<< HEAD
  }, modelRef);
=======
  };
}

export function applyDeepInfraConfig(
  cfg: OpenClawConfig,
  modelRef: string = DEEPINFRA_DEFAULT_MODEL_REF,
): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyDeepInfraProviderConfig(cfg, modelRef), modelRef);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}
