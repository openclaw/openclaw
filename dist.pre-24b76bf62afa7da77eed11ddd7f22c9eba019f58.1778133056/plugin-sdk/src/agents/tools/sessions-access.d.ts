import type { OpenClawConfig } from "../../config/types.openclaw.js";
export { createAgentToAgentPolicy, createSessionVisibilityChecker, createSessionVisibilityGuard, listSpawnedSessionKeys, resolveEffectiveSessionToolsVisibility, } from "../../plugin-sdk/session-visibility.js";
export declare function resolveSandboxedSessionToolContext(params: {
    cfg: OpenClawConfig;
    agentSessionKey?: string;
    sandboxed?: boolean;
}): {
    mainKey: string;
    alias: string;
    visibility: "spawned" | "all";
    requesterInternalKey: string | undefined;
    effectiveRequesterKey: string;
    restrictToSpawned: boolean;
};
