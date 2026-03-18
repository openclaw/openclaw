import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { AISA_BASE_URL, buildAisaProvider } from "./provider-catalog.js";

export const AISA_DEFAULT_MODEL_REF = "aisa/kimi-k2.5";

export function applyAisaProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[AISA_DEFAULT_MODEL_REF] = {
    ...models[AISA_DEFAULT_MODEL_REF],
    alias: models[AISA_DEFAULT_MODEL_REF]?.alias ?? "AIsa",
  };

  const provider = buildAisaProvider();
  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "aisa",
    api: "openai-completions",
    baseUrl: AISA_BASE_URL,
    catalogModels: provider.models,
  });
}

export function applyAisaConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyAisaProviderConfig(cfg), AISA_DEFAULT_MODEL_REF);
}
