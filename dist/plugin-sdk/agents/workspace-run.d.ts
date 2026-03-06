import type { OpenClawConfig } from "../config/config.js";
export type WorkspaceFallbackReason = "missing" | "blank" | "invalid_type";
type AgentIdSource = "explicit" | "session_key" | "default";
export type ResolveRunWorkspaceResult = {
    workspaceDir: string;
    usedFallback: boolean;
    fallbackReason?: WorkspaceFallbackReason;
    agentId: string;
    agentIdSource: AgentIdSource;
};
export declare function redactRunIdentifier(value: string | undefined): string;
export declare function resolveRunWorkspaceDir(params: {
    workspaceDir: unknown;
    sessionKey?: string;
    agentId?: string;
    config?: OpenClawConfig;
}): ResolveRunWorkspaceResult;
export {};
