// Runware setup module handles plugin onboarding behavior.
import {
  applyAgentDefaultModelPrimary,
  withAgentModelAliases,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { RUNWARE_DEFAULT_MODEL_REF } from "./models.js";

export { RUNWARE_DEFAULT_MODEL_REF };

const PROVIDER_ID = "runware";

// Catalog is fully dynamic: no fixed per-model allowlist to maintain here.
export function applyRunwareApiKeyConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next: OpenClawConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models: withAgentModelAliases(cfg.agents?.defaults?.models, [
          { modelRef: `${PROVIDER_ID}/*` },
        ]),
      },
    },
  };
  return applyAgentDefaultModelPrimary(next, RUNWARE_DEFAULT_MODEL_REF);
}
