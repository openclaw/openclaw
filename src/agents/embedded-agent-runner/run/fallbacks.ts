import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasConfiguredModelFallbacks } from "../../agent-scope.js";

/**
 * Reports whether the embedded run has model fallback candidates available,
 * honoring turn-local overrides before falling back to agent/default config.
 */
export function hasEmbeddedRunConfiguredModelFallbacks(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
  modelFallbacksOverride?: string[];
}): boolean {
  if (params.modelFallbacksOverride !== undefined) {
    // An explicit empty override disables inherited fallbacks for this run;
    // absence of an override is the only path that reads shared config.
    return params.modelFallbacksOverride.length > 0;
  }
  return hasConfiguredModelFallbacks({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
}
