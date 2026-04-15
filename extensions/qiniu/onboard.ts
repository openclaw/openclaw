import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildQiniuModelDefinition,
  QINIU_BASE_URL,
  QINIU_DEFAULT_MODEL_REF,
  QINIU_MODEL_CATALOG,
} from "./api.js";

export { QINIU_DEFAULT_MODEL_REF };

export function applyQiniuProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[QINIU_DEFAULT_MODEL_REF] = {
    ...models[QINIU_DEFAULT_MODEL_REF],
    alias: models[QINIU_DEFAULT_MODEL_REF]?.alias ?? "Qiniu",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "qiniu",
    api: "openai-completions",
    baseUrl: QINIU_BASE_URL,
    catalogModels: QINIU_MODEL_CATALOG.map(buildQiniuModelDefinition),
  });
}

export function applyQiniuConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyQiniuProviderConfig(cfg), QINIU_DEFAULT_MODEL_REF);
}
