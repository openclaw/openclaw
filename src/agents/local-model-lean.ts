import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope-config.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

const LOCAL_MODEL_LEAN_DENY_TOOL_NAMES = new Set(["browser", "cron", "message"]);
export const LOCAL_MODEL_LEAN_AUTO_MAX_CONTEXT_TOKENS = 64 * 1024;

export function normalizePositiveContextTokenBudget(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}

function shouldEnableAutoLocalModelLean(params: {
  contextTokenBudget?: number;
  modelContextWindowTokens?: number;
}): boolean {
  const contextTokens =
    normalizePositiveContextTokenBudget(params.contextTokenBudget) ??
    normalizePositiveContextTokenBudget(params.modelContextWindowTokens);
  return Boolean(contextTokens && contextTokens <= LOCAL_MODEL_LEAN_AUTO_MAX_CONTEXT_TOKENS);
}

function resolvePreservedLocalModelLeanToolNames(names?: Iterable<string>): Set<string> {
  if (!names) {
    return new Set();
  }
  return new Set(
    expandToolGroups([...names])
      .map(normalizeToolName)
      .filter((name) => name && name !== "*"),
  );
}

export function resolveLocalModelLeanPreserveToolNames(params?: {
  toolNames?: Iterable<string>;
  forceMessageTool?: boolean;
  sourceReplyDeliveryMode?: string;
}): string[] {
  const names = [...(params?.toolNames ?? [])];
  if (params?.forceMessageTool || params?.sourceReplyDeliveryMode === "message_tool_only") {
    names.push("message");
  }
  return [...new Set(names)];
}

function resolveLocalModelLeanAgentId(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  const explicitAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? normalizeAgentId(params.agentId)
      : undefined;
  if (explicitAgentId) {
    return explicitAgentId;
  }
  const parsedSessionAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  if (parsedSessionAgentId) {
    return normalizeAgentId(parsedSessionAgentId);
  }
  return params.config ? resolveDefaultAgentId(params.config) : undefined;
}

export function isLocalModelLeanEnabled(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  contextTokenBudget?: number;
  modelContextWindowTokens?: number;
}): boolean {
  const normalizedAgentId = resolveLocalModelLeanAgentId(params);
  const resolvedExperimental =
    params.config && normalizedAgentId
      ? (resolveAgentConfig(params.config, normalizedAgentId)?.experimental ??
        params.config.agents?.defaults?.experimental)
      : params.config?.agents?.defaults?.experimental;
  const leanMode = resolvedExperimental?.localModelLean;
  if (leanMode === "auto") {
    return shouldEnableAutoLocalModelLean(params);
  }
  return leanMode === true;
}

export function filterLocalModelLeanTools(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  preserveToolNames?: Iterable<string>;
  contextTokenBudget?: number;
  modelContextWindowTokens?: number;
}): AnyAgentTool[] {
  if (!isLocalModelLeanEnabled(params)) {
    return params.tools;
  }
  const preservedToolNames = resolvePreservedLocalModelLeanToolNames(params.preserveToolNames);
  return params.tools.filter((tool) => {
    const normalizedName = normalizeToolName(tool.name);
    return (
      preservedToolNames.has(normalizedName) ||
      !LOCAL_MODEL_LEAN_DENY_TOOL_NAMES.has(normalizedName)
    );
  });
}
