import { Cn as AgentDefaultsConfig, i as OpenClawConfig, rn as AgentConfig, xn as AgentContextLimitsConfig } from "./types.openclaw-BLF4DJTX.js";
import { y as AgentModelConfig } from "./types.models-tqxsISRc.js";
import { o as SessionEntry } from "./types-ChLEnNVH.js";

//#region src/config/sessions/model-override-provenance.d.ts
declare function hasSessionAutoModelFallbackProvenance(entry: Pick<SessionEntry, "providerOverride" | "modelOverride" | "modelOverrideFallbackOriginProvider" | "modelOverrideFallbackOriginModel"> | undefined): boolean;
//#endregion
//#region src/agents/agent-scope-config.d.ts
type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];
type ResolvedAgentConfig = {
  name?: string;
  workspace?: string;
  agentDir?: string;
  systemPromptOverride?: AgentEntry["systemPromptOverride"];
  model?: AgentEntry["model"];
  thinkingDefault?: AgentEntry["thinkingDefault"];
  verboseDefault?: AgentDefaultsConfig["verboseDefault"];
  reasoningDefault?: AgentEntry["reasoningDefault"];
  fastModeDefault?: AgentEntry["fastModeDefault"];
  contextInjection?: AgentEntry["contextInjection"];
  bootstrapMaxChars?: AgentEntry["bootstrapMaxChars"];
  bootstrapTotalMaxChars?: AgentEntry["bootstrapTotalMaxChars"];
  experimental?: AgentDefaultsConfig["experimental"];
  skills?: AgentEntry["skills"];
  memorySearch?: AgentEntry["memorySearch"];
  humanDelay?: AgentEntry["humanDelay"];
  tts?: AgentEntry["tts"];
  contextLimits?: AgentContextLimitsConfig;
  heartbeat?: AgentEntry["heartbeat"];
  identity?: AgentEntry["identity"];
  groupChat?: AgentEntry["groupChat"];
  subagents?: AgentEntry["subagents"];
  runRetries?: AgentEntry["runRetries"];
  embeddedPi?: AgentEntry["embeddedPi"];
  sandbox?: AgentEntry["sandbox"];
  tools?: AgentEntry["tools"];
};
declare function listAgentEntries(cfg: OpenClawConfig): AgentEntry[];
declare function listAgentIds(cfg: OpenClawConfig): string[];
declare function resolveDefaultAgentId(cfg: OpenClawConfig): string;
declare function resolveAgentConfig(cfg: OpenClawConfig, agentId: string): ResolvedAgentConfig | undefined;
declare function resolveAgentContextLimits(cfg: OpenClawConfig | undefined, agentId?: string | null): AgentContextLimitsConfig | undefined;
declare function resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string, env?: NodeJS.ProcessEnv): string;
declare function resolveAgentDir(cfg: OpenClawConfig, agentId: string, env?: NodeJS.ProcessEnv): string;
declare function resolveDefaultAgentDir(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): string;
//#endregion
//#region src/agents/agent-scope.d.ts
type AutoFallbackPrimaryProbe = {
  provider: string;
  model: string;
  fallbackProvider: string;
  fallbackModel: string;
  fallbackAuthProfileId?: string;
  fallbackAuthProfileIdSource?: "auto" | "user";
};
declare function resolveAutoFallbackPrimaryProbe(params: {
  entry: Pick<SessionEntry, "providerOverride" | "modelOverride" | "modelOverrideSource" | "modelOverrideFallbackOriginProvider" | "modelOverrideFallbackOriginModel" | "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount"> | null | undefined;
  sessionKey?: string | null;
  primaryProvider: string;
  primaryModel: string;
  now?: number;
  minIntervalMs?: number;
  maxTrackedProbeKeys?: number;
  probeState?: Map<string, number>;
}): AutoFallbackPrimaryProbe | undefined;
declare function markAutoFallbackPrimaryProbe(params: {
  probe: AutoFallbackPrimaryProbe;
  sessionKey?: string | null;
  now?: number;
  minIntervalMs?: number;
  maxTrackedProbeKeys?: number;
  probeState?: Map<string, number>;
}): void;
declare function entryMatchesAutoFallbackPrimaryProbe(entry: Pick<SessionEntry, "providerOverride" | "modelOverride" | "modelOverrideSource" | "modelOverrideFallbackOriginProvider" | "modelOverrideFallbackOriginModel"> | null | undefined, probe: AutoFallbackPrimaryProbe): boolean;
declare function clearAutoFallbackPrimaryProbeSelection(entry: SessionEntry, now?: number): void;
declare function resolveSessionAgentIds(params: {
  sessionKey?: string;
  config?: OpenClawConfig;
  agentId?: string;
}): {
  defaultAgentId: string;
  sessionAgentId: string;
};
declare function resolveSessionAgentId(params: {
  sessionKey?: string;
  config?: OpenClawConfig;
}): string;
declare function resolveAgentExecutionContract(cfg: OpenClawConfig | undefined, agentId?: string | null): NonNullable<NonNullable<AgentDefaultsConfig["embeddedPi"]>["executionContract"]> | undefined;
declare function resolveAgentSkillsFilter(cfg: OpenClawConfig, agentId: string): string[] | undefined;
declare function resolveAgentExplicitModelPrimary(cfg: OpenClawConfig, agentId: string): string | undefined;
declare function resolveAgentEffectiveModelPrimary(cfg: OpenClawConfig, agentId: string): string | undefined;
type AgentModelPrimaryWriteTarget = "agent" | "defaults";
declare function setAgentEffectiveModelPrimary(cfg: OpenClawConfig, agentId: string, primary: string): AgentModelPrimaryWriteTarget;
/** @deprecated Prefer explicit/effective helpers at new call sites. */
declare function resolveAgentModelPrimary(cfg: OpenClawConfig, agentId: string): string | undefined;
declare function resolveAgentModelFallbacksOverride(cfg: OpenClawConfig, agentId: string): string[] | undefined;
type SubagentModelConfigSelectionSource = "subagent" | "agent" | "default-subagent";
type SubagentModelConfigSelectionResult = {
  raw: AgentModelConfig;
  source: SubagentModelConfigSelectionSource;
};
declare function resolveSubagentModelConfigSelectionResult(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentConfigOverride?: Pick<AgentConfig, "model" | "subagents">;
}): SubagentModelConfigSelectionResult | undefined;
declare function resolveSubagentModelConfigSelection(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentConfigOverride?: Pick<AgentConfig, "model" | "subagents">;
}): AgentModelConfig | undefined;
declare function resolveSubagentModelFallbacksOverride(cfg: OpenClawConfig, agentId: string): string[] | undefined;
declare function resolveFallbackAgentId(params: {
  agentId?: string | null;
  sessionKey?: string | null;
}): string;
declare function resolveRunModelFallbacksOverride(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): string[] | undefined;
declare function hasConfiguredModelFallbacks(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): boolean;
declare function resolveEffectiveModelFallbacks(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string | null;
  hasSessionModelOverride: boolean;
  modelOverrideSource?: "auto" | "user";
  hasAutoFallbackProvenance?: boolean;
}): string[] | undefined;
declare function resolveAgentIdsByWorkspacePath(cfg: OpenClawConfig, workspacePath: string): string[];
declare function resolveAgentIdByWorkspacePath(cfg: OpenClawConfig, workspacePath: string): string | undefined;
//#endregion
export { resolveAgentConfig as A, resolveSubagentModelConfigSelection as C, ResolvedAgentConfig as D, setAgentEffectiveModelPrimary as E, resolveDefaultAgentId as F, hasSessionAutoModelFallbackProvenance as I, resolveAgentDir as M, resolveAgentWorkspaceDir as N, listAgentEntries as O, resolveDefaultAgentDir as P, resolveSessionAgentIds as S, resolveSubagentModelFallbacksOverride as T, resolveAutoFallbackPrimaryProbe as _, clearAutoFallbackPrimaryProbeSelection as a, resolveRunModelFallbacksOverride as b, markAutoFallbackPrimaryProbe as c, resolveAgentExplicitModelPrimary as d, resolveAgentIdByWorkspacePath as f, resolveAgentSkillsFilter as g, resolveAgentModelPrimary as h, SubagentModelConfigSelectionSource as i, resolveAgentContextLimits as j, listAgentIds as k, resolveAgentEffectiveModelPrimary as l, resolveAgentModelFallbacksOverride as m, AutoFallbackPrimaryProbe as n, entryMatchesAutoFallbackPrimaryProbe as o, resolveAgentIdsByWorkspacePath as p, SubagentModelConfigSelectionResult as r, hasConfiguredModelFallbacks as s, AgentModelPrimaryWriteTarget as t, resolveAgentExecutionContract as u, resolveEffectiveModelFallbacks as v, resolveSubagentModelConfigSelectionResult as w, resolveSessionAgentId as x, resolveFallbackAgentId as y };