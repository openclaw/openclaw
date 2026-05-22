export { hasSessionAutoModelFallbackProvenance } from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
export { listAgentEntries, listAgentIds, resolveAgentConfig, resolveAgentContextLimits, resolveAgentDir, resolveDefaultAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId, type ResolvedAgentConfig, } from "./agent-scope-config.js";
export type AutoFallbackPrimaryProbe = {
    provider: string;
    model: string;
    fallbackProvider: string;
    fallbackModel: string;
    fallbackAuthProfileId?: string;
    fallbackAuthProfileIdSource?: "auto" | "user";
};
export declare function resolveAutoFallbackPrimaryProbe(params: {
    entry: Pick<SessionEntry, "providerOverride" | "modelOverride" | "modelOverrideSource" | "modelOverrideFallbackOriginProvider" | "modelOverrideFallbackOriginModel" | "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount"> | null | undefined;
    sessionKey?: string | null;
    primaryProvider: string;
    primaryModel: string;
    now?: number;
    minIntervalMs?: number;
    maxTrackedProbeKeys?: number;
    probeState?: Map<string, number>;
}): AutoFallbackPrimaryProbe | undefined;
export declare function markAutoFallbackPrimaryProbe(params: {
    probe: AutoFallbackPrimaryProbe;
    sessionKey?: string | null;
    now?: number;
    minIntervalMs?: number;
    maxTrackedProbeKeys?: number;
    probeState?: Map<string, number>;
}): void;
export declare function entryMatchesAutoFallbackPrimaryProbe(entry: Pick<SessionEntry, "providerOverride" | "modelOverride" | "modelOverrideSource" | "modelOverrideFallbackOriginProvider" | "modelOverrideFallbackOriginModel"> | null | undefined, probe: AutoFallbackPrimaryProbe): boolean;
export declare function clearAutoFallbackPrimaryProbeSelection(entry: SessionEntry, now?: number): void;
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
export type SubagentModelConfigSelectionSource = "subagent" | "agent" | "default-subagent";
export type SubagentModelConfigSelectionResult = {
    raw: AgentModelConfig;
    source: SubagentModelConfigSelectionSource;
};
export declare function resolveSubagentModelConfigSelectionResult(params: {
    cfg: OpenClawConfig;
    agentId?: string;
    agentConfigOverride?: Pick<AgentConfig, "model" | "subagents">;
}): SubagentModelConfigSelectionResult | undefined;
export declare function resolveSubagentModelConfigSelection(params: {
    cfg: OpenClawConfig;
    agentId?: string;
    agentConfigOverride?: Pick<AgentConfig, "model" | "subagents">;
}): AgentModelConfig | undefined;
export declare function resolveSubagentModelFallbacksOverride(cfg: OpenClawConfig, agentId: string): string[] | undefined;
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
    sessionKey?: string | null;
    hasSessionModelOverride: boolean;
    modelOverrideSource?: "auto" | "user";
    hasAutoFallbackProvenance?: boolean;
}): string[] | undefined;
export declare function resolveAgentIdsByWorkspacePath(cfg: OpenClawConfig, workspacePath: string): string[];
export declare function resolveAgentIdByWorkspacePath(cfg: OpenClawConfig, workspacePath: string): string | undefined;
