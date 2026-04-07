// Onboarding helper for the Atlas Cloud video generation provider.
// Sets a sensible default video model when the user first adds an Atlas
// Cloud API key through the wizard, but never overwrites a user choice.
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";

export const ATLASCLOUD_DEFAULT_VIDEO_MODEL_REF =
  "atlascloud/google/veo3.1-fast/text-to-video";

export function applyAtlasCloudConfig(cfg: OpenClawConfig): OpenClawConfig {
  if (cfg.agents?.defaults?.videoGenerationModel) {
    return cfg;
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        videoGenerationModel: {
          primary: ATLASCLOUD_DEFAULT_VIDEO_MODEL_REF,
        },
      },
    },
  };
}
