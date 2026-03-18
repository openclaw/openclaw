import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_DEFAULT_MODEL_REF,
} from "openclaw/plugin-sdk/provider-models";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildDeepInfraStaticProvider } from "./provider-catalog.js";

export { DEEPINFRA_BASE_URL, DEEPINFRA_DEFAULT_MODEL_REF };

export function applyDeepInfraProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[DEEPINFRA_DEFAULT_MODEL_REF] = {
    ...models[DEEPINFRA_DEFAULT_MODEL_REF],
    alias: models[DEEPINFRA_DEFAULT_MODEL_REF]?.alias ?? "DeepInfra",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "deepinfra",
    api: "openai-completions",
    baseUrl: DEEPINFRA_BASE_URL,
    catalogModels: buildDeepInfraStaticProvider().models ?? [],
  });
}

export function applyDeepInfraConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyDeepInfraProviderConfig(cfg),
    DEEPINFRA_DEFAULT_MODEL_REF,
  );
}
