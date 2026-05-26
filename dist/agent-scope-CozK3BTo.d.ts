import { hn as AgentDefaultsConfig, i as OpenClawConfig, pn as AgentContextLimitsConfig } from "./types.openclaw-DIZy8jcb.js";
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
  skills?: AgentEntry["skills"];
  memorySearch?: AgentEntry["memorySearch"];
  humanDelay?: AgentEntry["humanDelay"];
  tts?: AgentEntry["tts"];
  contextLimits?: AgentContextLimitsConfig;
  heartbeat?: AgentEntry["heartbeat"];
  identity?: AgentEntry["identity"];
  groupChat?: AgentEntry["groupChat"];
  subagents?: AgentEntry["subagents"];
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
  hasSessionModelOverride: boolean;
  modelOverrideSource?: "auto" | "user";
}): string[] | undefined;
declare function resolveAgentIdsByWorkspacePath(cfg: OpenClawConfig, workspacePath: string): string[];
declare function resolveAgentIdByWorkspacePath(cfg: OpenClawConfig, workspacePath: string): string | undefined;
//#endregion
export { resolveAgentWorkspaceDir as C, resolveAgentDir as S, resolveDefaultAgentId as T, ResolvedAgentConfig as _, resolveAgentExplicitModelPrimary as a, resolveAgentConfig as b, resolveAgentModelFallbacksOverride as c, resolveEffectiveModelFallbacks as d, resolveFallbackAgentId as f, setAgentEffectiveModelPrimary as g, resolveSessionAgentIds as h, resolveAgentExecutionContract as i, resolveAgentModelPrimary as l, resolveSessionAgentId as m, hasConfiguredModelFallbacks as n, resolveAgentIdByWorkspacePath as o, resolveRunModelFallbacksOverride as p, resolveAgentEffectiveModelPrimary as r, resolveAgentIdsByWorkspacePath as s, AgentModelPrimaryWriteTarget as t, resolveAgentSkillsFilter as u, listAgentEntries as v, resolveDefaultAgentDir as w, resolveAgentContextLimits as x, listAgentIds as y };