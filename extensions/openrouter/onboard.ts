import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModelsPreset,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenrouterProvider, OPENROUTER_BASE_URL } from "./provider-catalog.js";

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
  const provider = buildOpenrouterProvider();
  const next = applyProviderConfigWithDefaultModelsPreset(cfg, {
    providerId: "openrouter",
    api: "openai-completions",
    baseUrl: OPENROUTER_BASE_URL,
    defaultModels: provider.models,
    aliases: [{ modelRef: OPENROUTER_DEFAULT_MODEL_REF, alias: "OpenRouter" }],
  });
  return applyAgentDefaultModelPrimary(next, OPENROUTER_DEFAULT_MODEL_REF);
}
