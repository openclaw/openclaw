import {
  applyAgentDefaultMediaModel,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

const VYDRA_DEFAULT_IMAGE_MODEL_REF = "vydra/grok-imagine";

export function applyVydraConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultMediaModel(cfg, "image", VYDRA_DEFAULT_IMAGE_MODEL_REF);
}
