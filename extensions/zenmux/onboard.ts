import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { discoverZenmuxModels, ZENMUX_BASE_URL } from "./zenmux-models.js";

export const ZENMUX_DEFAULT_MODEL_REF = "zenmux/openai/gpt-5.2";

export function applyZenmuxProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[ZENMUX_DEFAULT_MODEL_REF] = {
    ...models[ZENMUX_DEFAULT_MODEL_REF],
    alias: models[ZENMUX_DEFAULT_MODEL_REF]?.alias ?? "ZenMux",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "zenmux",
    api: "openai-completions",
    baseUrl: ZENMUX_BASE_URL,
    catalogModels: [
      {
        id: "openai/gpt-5.2",
        name: "GPT-5.2",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  });
}

export function applyZenmuxConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyZenmuxProviderConfig(cfg), ZENMUX_DEFAULT_MODEL_REF);
}
