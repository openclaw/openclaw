import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModels,
  type ModelApi,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildErnieProvider, ERNIE_BASE_URL, ERNIE_DEFAULT_MODEL_ID } from "./provider-catalog.js";

export const ERNIE_DEFAULT_MODEL_REF = `ernie/${ERNIE_DEFAULT_MODEL_ID}`;

export function applyErnieProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[ERNIE_DEFAULT_MODEL_REF] = {
    ...models[ERNIE_DEFAULT_MODEL_REF],
    alias: models[ERNIE_DEFAULT_MODEL_REF]?.alias ?? "ERNIE",
  };
  const defaultProvider = buildErnieProvider();
  const existingProvider = cfg.models?.providers?.ernie as
    | {
        baseUrl?: unknown;
        api?: unknown;
      }
    | undefined;
  const existingBaseUrl =
    typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
  const resolvedBaseUrl = existingBaseUrl || ERNIE_BASE_URL;
  const resolvedApi =
    typeof existingProvider?.api === "string"
      ? (existingProvider.api as ModelApi)
      : "openai-completions";

  return applyProviderConfigWithDefaultModels(cfg, {
    agentModels: models,
    providerId: "ernie",
    api: resolvedApi,
    baseUrl: resolvedBaseUrl,
    defaultModels: defaultProvider.models ?? [],
    defaultModelId: ERNIE_DEFAULT_MODEL_ID,
  });
}

export function applyErnieConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyErnieProviderConfig(cfg), ERNIE_DEFAULT_MODEL_REF);
}
