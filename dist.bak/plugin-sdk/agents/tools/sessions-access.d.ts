import type { OpenClawConfig } from "../../config/config.js";
export type SessionToolsVisibility = "self" | "tree" | "agent" | "all";
export type AgentToAgentPolicy = {
    enabled: boolean;
    matchesAllow: (agentId: string) => boolean;
    isAllowed: (requesterAgentId: string, targetAgentId: string) => boolean;
};
export type SessionAccessAction = "history" | "send" | "list";
export type SessionAccessResult = {
    allowed: true;
} | {
    allowed: false;
    error: string;
    status: "forbidden";
};
export declare function resolveSessionToolsVisibility(cfg: OpenClawConfig): SessionToolsVisibility;
export declare function resolveEffectiveSessionToolsVisibility(params: {
    cfg: OpenClawConfig;
    sandboxed: boolean;
}): SessionToolsVisibility;
export declare function resolveSandboxSessionToolsVisibility(cfg: OpenClawConfig): "spawned" | "all";
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
export declare function createAgentToAgentPolicy(cfg: OpenClawConfig): AgentToAgentPolicy;
export declare function createSessionVisibilityGuard(params: {
    action: SessionAccessAction;
    requesterSessionKey: string;
    visibility: SessionToolsVisibility;
    a2aPolicy: AgentToAgentPolicy;
}): Promise<{
    check: (targetSessionKey: string) => SessionAccessResult;
}>;
