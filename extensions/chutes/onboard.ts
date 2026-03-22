import {
  CHUTES_BASE_URL,
  CHUTES_DEFAULT_MODEL_REF,
  CHUTES_MODEL_CATALOG,
  buildChutesModelDefinition,
} from "openclaw/plugin-sdk/provider-models";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export { CHUTES_DEFAULT_MODEL_REF };

/**
 * Apply Chutes provider configuration without changing the default model.
 * Registers all catalog models and sets provider aliases (chutes-fast, etc.).
 */
export function applyChutesProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  for (const m of CHUTES_MODEL_CATALOG) {
    models[`chutes/${m.id}`] = {
      ...models[`chutes/${m.id}`],
    };
  }

  models["chutes-fast"] = { alias: "chutes/zai-org/GLM-4.7-FP8" };
  models["chutes-vision"] = { alias: "chutes/chutesai/Mistral-Small-3.2-24B-Instruct-2506" };
  models["chutes-pro"] = { alias: "chutes/deepseek-ai/DeepSeek-V3.2-TEE" };

  const chutesModels = CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition);
  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "chutes",
    api: "openai-completions",
    baseUrl: CHUTES_BASE_URL,
    catalogModels: chutesModels,
  });
}

/**
 * Apply Chutes provider configuration AND set Chutes as the default model.
 */
export function applyChutesConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyChutesProviderConfig(cfg);
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          primary: CHUTES_DEFAULT_MODEL_REF,
          fallbacks: ["chutes/deepseek-ai/DeepSeek-V3.2-TEE", "chutes/Qwen/Qwen3-32B"],
        },
        imageModel: {
          primary: "chutes/chutesai/Mistral-Small-3.2-24B-Instruct-2506",
          fallbacks: ["chutes/chutesai/Mistral-Small-3.1-24B-Instruct-2503"],
        },
      },
    },
  };
}

export function applyChutesApiKeyConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyChutesProviderConfig(cfg), CHUTES_DEFAULT_MODEL_REF);
}
