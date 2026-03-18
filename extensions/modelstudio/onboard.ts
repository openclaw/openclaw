import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  MODELSTUDIO_CN_BASE_URL,
  MODELSTUDIO_DEFAULT_MODEL_REF,
  MODELSTUDIO_GLOBAL_BASE_URL,
} from "./model-definitions.js";
import { buildModelStudioProvider } from "./provider-catalog.js";

export { MODELSTUDIO_CN_BASE_URL, MODELSTUDIO_DEFAULT_MODEL_REF, MODELSTUDIO_GLOBAL_BASE_URL };

function applyModelStudioProviderConfigWithBaseUrl(
  cfg: OpenClawConfig,
  baseUrl: string,
): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  const provider = buildModelStudioProvider();
  for (const model of provider.models ?? []) {
    const modelRef = `modelstudio/${model.id}`;
    if (!models[modelRef]) {
      models[modelRef] = {};
    }
  }
  models[MODELSTUDIO_DEFAULT_MODEL_REF] = {
    ...models[MODELSTUDIO_DEFAULT_MODEL_REF],
    alias: models[MODELSTUDIO_DEFAULT_MODEL_REF]?.alias ?? "Qwen",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "modelstudio",
    api: provider.api ?? "openai-completions",
    baseUrl,
    catalogModels: provider.models ?? [],
  });
}

export function applyModelStudioProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyModelStudioProviderConfigWithBaseUrl(cfg, MODELSTUDIO_GLOBAL_BASE_URL);
}

export function applyModelStudioProviderConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return applyModelStudioProviderConfigWithBaseUrl(cfg, MODELSTUDIO_CN_BASE_URL);
}

export function applyModelStudioConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyModelStudioProviderConfig(cfg),
    MODELSTUDIO_DEFAULT_MODEL_REF,
  );
}

export function applyModelStudioConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyModelStudioProviderConfigCn(cfg),
    MODELSTUDIO_DEFAULT_MODEL_REF,
  );
}
