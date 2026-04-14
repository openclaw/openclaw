import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";

export const KLINGAI_DEFAULT_IMAGE_MODEL_REF = "klingai/kling-v3";
export const KLINGAI_DEFAULT_VIDEO_MODEL_REF = "klingai/kling-v3";
export const KLINGAI_GLOBAL_BASE_URL = "https://api-singapore.klingai.com";
export const KLINGAI_CN_BASE_URL = "https://api-beijing.klingai.com";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

function applyKlingaiBaseUrl(cfg: OpenClawConfig, baseUrl: string): OpenClawConfig {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const existingModels = cfg.models?.providers?.klingai?.models;
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        klingai: {
          ...cfg.models?.providers?.klingai,
          baseUrl: normalizedBaseUrl,
          models: Array.isArray(existingModels) ? existingModels : [],
        },
      },
    },
  };
}

export function applyKlingaiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        imageGenerationModel:
          cfg.agents?.defaults?.imageGenerationModel ?? {
            primary: KLINGAI_DEFAULT_IMAGE_MODEL_REF,
          },
        videoGenerationModel:
          cfg.agents?.defaults?.videoGenerationModel ?? {
            primary: KLINGAI_DEFAULT_VIDEO_MODEL_REF,
          },
      },
    },
  };
}

export function applyKlingaiGlobalConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyKlingaiBaseUrl(applyKlingaiConfig(cfg), KLINGAI_GLOBAL_BASE_URL);
}

export function applyKlingaiCnConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyKlingaiBaseUrl(applyKlingaiConfig(cfg), KLINGAI_CN_BASE_URL);
}
