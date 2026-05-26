import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
export type ResolveContextEngineCapabilitiesParams = {
    config?: OpenClawConfig;
    sessionKey?: string;
    agentId?: string;
    contextEnginePluginId?: string;
    purpose: string;
};
/**
 * Build host-owned capabilities that are bound to one context-engine runtime call.
 */
export declare function resolveContextEngineCapabilities(params: ResolveContextEngineCapabilitiesParams): Pick<ContextEngineRuntimeContext, "llm">;
