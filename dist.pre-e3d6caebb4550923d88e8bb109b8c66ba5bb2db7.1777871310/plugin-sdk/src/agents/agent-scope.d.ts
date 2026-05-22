import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
export { listAgentEntries, listAgentIds, resolveAgentConfig, resolveAgentContextLimits, resolveAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId, type ResolvedAgentConfig, } from "./agent-scope-config.js";
export { resolveAgentIdFromSessionKey };
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
export declare function resolveAgentExecutionContract(cfg: OpenClawConfig | undefined, agentId?: string | null): NonNullable<NonNullable<AgentDefaultsConfig["embeddedPi"]>["executionContract"]> | undefined;
export declare function resolveAgentSkillsFilter(cfg: OpenClawConfig, agentId: string): string[] | undefined;
export declare function resolveAgentExplicitModelPrimary(cfg: OpenClawConfig, agentId: string): string | undefined;
export declare function resolveAgentEffectiveModelPrimary(cfg: OpenClawConfig, agentId: string): string | undefined;
export type AgentModelPrimaryWriteTarget = "agent" | "defaults";
export declare function setAgentEffectiveModelPrimary(cfg: OpenClawConfig, agentId: string, primary: string): AgentModelPrimaryWriteTarget;
/** @deprecated Prefer explicit/effective helpers at new call sites. */
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
    modelOverrideSource?: "auto" | "user";
}): string[] | undefined;
export declare function resolveAgentIdsByWorkspacePath(cfg: OpenClawConfig, workspacePath: string): string[];
export declare function resolveAgentIdByWorkspacePath(cfg: OpenClawConfig, workspacePath: string): string | undefined;
