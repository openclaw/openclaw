import { applyAgentDefaultModelPrimary } from "../../src/commands/onboard-auth.config-shared.js";
import type { OpenClawConfig } from "../../src/config/config.js";

export const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";

export function applyOpenrouterProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[OPENROUTER_DEFAULT_MODEL_REF] = {
    ...models[OPENROUTER_DEFAULT_MODEL_REF],
    alias: models[OPENROUTER_DEFAULT_MODEL_REF]?.alias ?? "OpenRouter",
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

export function applyOpenrouterConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyOpenrouterProviderConfig(cfg),
    OPENROUTER_DEFAULT_MODEL_REF,
  );
}
