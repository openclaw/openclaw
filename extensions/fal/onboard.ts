import {
  applyAgentDefaultMediaModel,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

const FAL_DEFAULT_IMAGE_MODEL_REF = "fal/fal-ai/flux/dev";

export function applyFalConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultMediaModel(cfg, "image", FAL_DEFAULT_IMAGE_MODEL_REF);
}
