import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope-config.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

const LOCAL_MODEL_LEAN_DENY_TOOL_NAMES = new Set([
  "browser",
  "cron",
  "message",
  "web_fetch",
  "web_search",
  "x_search",
]);

function resolvePreservedLocalModelLeanToolNames(names?: Iterable<string>): string[] {
  if (!names) {
    return [];
  }
  return expandToolGroups([...names])
    .map(normalizeToolName)
    .filter((name) => name && name !== "*");
}

function isLocalModelLeanToolPreserved(toolName: string, preservedToolNames: string[]): boolean {
  return (
    preservedToolNames.length > 0 &&
    isToolAllowedByPolicyName(toolName, { allow: preservedToolNames })
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
}): boolean {
  const normalizedAgentId = resolveLocalModelLeanAgentId(params);
  const resolvedExperimental =
    params.config && normalizedAgentId
      ? (resolveAgentConfig(params.config, normalizedAgentId)?.experimental ??
        params.config.agents?.defaults?.experimental)
      : params.config?.agents?.defaults?.experimental;
  return resolvedExperimental?.localModelLean ?? false;
}

export function isLocalModelLeanToolTrimmed(params: {
  toolName: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  preserveToolNames?: Iterable<string>;
}): boolean {
  if (
    !isLocalModelLeanEnabled({
      config: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    })
  ) {
    return false;
  }
  const normalizedName = normalizeToolName(params.toolName);
  if (!LOCAL_MODEL_LEAN_DENY_TOOL_NAMES.has(normalizedName)) {
    return false;
  }
  return !isLocalModelLeanToolPreserved(
    normalizedName,
    resolvePreservedLocalModelLeanToolNames(params.preserveToolNames),
  );
}

export function filterLocalModelLeanTools(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  preserveToolNames?: Iterable<string>;
}): AnyAgentTool[] {
  if (!isLocalModelLeanEnabled(params)) {
    return params.tools;
  }
  const preservedToolNames = resolvePreservedLocalModelLeanToolNames(params.preserveToolNames);
  return params.tools.filter((tool) => {
    const normalizedName = normalizeToolName(tool.name);
    return (
      isLocalModelLeanToolPreserved(normalizedName, preservedToolNames) ||
      !LOCAL_MODEL_LEAN_DENY_TOOL_NAMES.has(normalizedName)
    );
  });
}
