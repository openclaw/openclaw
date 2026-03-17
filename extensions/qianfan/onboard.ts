import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModels,
} from "../../src/commands/onboard-auth.config-shared.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import type { ModelApi } from "../../src/config/types.models.js";
import {
  buildQianfanProvider,
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

export const QIANFAN_DEFAULT_MODEL_REF = `qianfan/${QIANFAN_DEFAULT_MODEL_ID}`;

export function applyQianfanProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[QIANFAN_DEFAULT_MODEL_REF] = {
    ...models[QIANFAN_DEFAULT_MODEL_REF],
    alias: models[QIANFAN_DEFAULT_MODEL_REF]?.alias ?? "QIANFAN",
  };
  const defaultProvider = buildQianfanProvider();
  const existingProvider = cfg.models?.providers?.qianfan as
    | {
        baseUrl?: unknown;
        api?: unknown;
      }
    | undefined;
  const existingBaseUrl =
    typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
  const resolvedBaseUrl = existingBaseUrl || QIANFAN_BASE_URL;
  const resolvedApi =
    typeof existingProvider?.api === "string"
      ? (existingProvider.api as ModelApi)
      : "openai-completions";

  return applyProviderConfigWithDefaultModels(cfg, {
    agentModels: models,
    providerId: "qianfan",
    api: resolvedApi,
    baseUrl: resolvedBaseUrl,
    defaultModels: defaultProvider.models ?? [],
    defaultModelId: QIANFAN_DEFAULT_MODEL_ID,
  });
}

export function applyQianfanConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyQianfanProviderConfig(cfg), QIANFAN_DEFAULT_MODEL_REF);
}
