import type { MullusiConfig } from "mullusi/plugin-sdk/provider-onboard";

export const FAL_DEFAULT_IMAGE_MODEL_REF = "fal/fal-ai/flux/dev";

export function applyFalConfig(cfg: MullusiConfig): MullusiConfig {
  if (cfg.agents?.defaults?.imageGenerationModel) {
    return cfg;
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        imageGenerationModel: {
          primary: FAL_DEFAULT_IMAGE_MODEL_REF,
        },
      },
    },
  };
}
