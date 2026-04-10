import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { VIDU_BASE_URL, VIDU_CN_BASE_URL } from "./models.js";

export const VIDU_DEFAULT_VIDEO_MODEL_REF = "vidu/viduq3-pro";

function applyViduBaseConfig(cfg: OpenClawConfig, baseUrl: string): OpenClawConfig {
  const updated: OpenClawConfig = {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        vidu: {
          ...cfg.models?.providers?.vidu,
          baseUrl,
          models: cfg.models?.providers?.vidu?.models ?? [],
        },
      },
    },
  };
  if (cfg.agents?.defaults?.videoGenerationModel) {
    return updated;
  }
  return {
    ...updated,
    agents: {
      ...updated.agents,
      defaults: {
        ...updated.agents?.defaults,
        videoGenerationModel: {
          primary: VIDU_DEFAULT_VIDEO_MODEL_REF,
        },
      },
    },
  };
}

export function applyViduConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyViduBaseConfig(cfg, VIDU_BASE_URL);
}

export function applyViduConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return applyViduBaseConfig(cfg, VIDU_CN_BASE_URL);
}
