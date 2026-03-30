import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
export { resolveAgentIdFromSessionKey };
type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];
type ResolvedAgentConfig = {
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: AgentEntry["model"];
    skills?: AgentEntry["skills"];
    memorySearch?: AgentEntry["memorySearch"];
    humanDelay?: AgentEntry["humanDelay"];
    heartbeat?: AgentEntry["heartbeat"];
    identity?: AgentEntry["identity"];
    groupChat?: AgentEntry["groupChat"];
    subagents?: AgentEntry["subagents"];
    sandbox?: AgentEntry["sandbox"];
    tools?: AgentEntry["tools"];
};
export declare function listAgentEntries(cfg: OpenClawConfig): AgentEntry[];
export declare function listAgentIds(cfg: OpenClawConfig): string[];
export declare function resolveDefaultAgentId(cfg: OpenClawConfig): string;
export declare function resolveSessionAgentIds(params: {
    sessionKey?: string;
    config?: OpenClawConfig;
    agentId?: string;
}): {
    defaultAgentId: string;
    sessionAgentId: string;
};
export declare function resolveSessionAgentId(params: {
    sessionKey?: string;
    config?: OpenClawConfig;
}): string;
export declare function resolveAgentConfig(cfg: OpenClawConfig, agentId: string): ResolvedAgentConfig | undefined;
export declare function resolveAgentSkillsFilter(cfg: OpenClawConfig, agentId: string): string[] | undefined;
export declare function resolveAgentExplicitModelPrimary(cfg: OpenClawConfig, agentId: string): string | undefined;
export declare function resolveAgentEffectiveModelPrimary(cfg: OpenClawConfig, agentId: string): string | undefined;
export declare function resolveAgentModelPrimary(cfg: OpenClawConfig, agentId: string): string | undefined;
export declare function resolveAgentModelFallbacksOverride(cfg: OpenClawConfig, agentId: string): string[] | undefined;
export declare function resolveFallbackAgentId(params: {
    agentId?: string | null;
    sessionKey?: string | null;
}): string;
export declare function resolveRunModelFallbacksOverride(params: {
    cfg: OpenClawConfig | undefined;
    agentId?: string | null;
    sessionKey?: string | null;
}): string[] | undefined;
export declare function hasConfiguredModelFallbacks(params: {
    cfg: OpenClawConfig | undefined;
    agentId?: string | null;
    sessionKey?: string | null;
}): boolean;
export declare function resolveEffectiveModelFallbacks(params: {
    cfg: OpenClawConfig;
    agentId: string;
    hasSessionModelOverride: boolean;
}): string[] | undefined;
export declare function resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string): string;
export declare function resolveAgentDir(cfg: OpenClawConfig, agentId: string): string;
