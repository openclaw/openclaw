import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export declare function hasEmbeddedRunConfiguredModelFallbacks(params: {
    cfg: OpenClawConfig | undefined;
    agentId?: string | null;
    sessionKey?: string | null;
    modelFallbacksOverride?: string[];
}): boolean;
