import type { LocalModelLeanProfile } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope-config.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

const DEFAULT_LOCAL_MODEL_LEAN_PROFILE = "basic" satisfies LocalModelLeanProfile;
const LOCAL_MODEL_LEAN_BASIC_DENY_TOOL_NAMES = new Set(["browser", "cron", "message"]);
const LOCAL_MODEL_LEAN_STRICT_ALLOW_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "exec",
  "wait",
  "apply_patch",
  "process",
  "session_status",
  "update_plan",
]);

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
}): boolean {
  return resolveLocalModelLeanProfile(params) !== undefined;
}

export function resolveLocalModelLeanProfile(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): LocalModelLeanProfile | undefined {
  const normalizedAgentId = resolveLocalModelLeanAgentId(params);
  const resolvedExperimental =
    params.config && normalizedAgentId
      ? (resolveAgentConfig(params.config, normalizedAgentId)?.experimental ??
        params.config.agents?.defaults?.experimental)
      : params.config?.agents?.defaults?.experimental;
  if (!resolvedExperimental?.localModelLean) {
    return undefined;
  }
  return resolvedExperimental.localModelLeanProfile ?? DEFAULT_LOCAL_MODEL_LEAN_PROFILE;
}

export function filterLocalModelLeanTools(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  preserveToolNames?: Iterable<string>;
}): AnyAgentTool[] {
  const profile = resolveLocalModelLeanProfile(params);
  if (!profile) {
    return params.tools;
  }
  if (profile === "strict") {
    const preservedToolNames = resolvePreservedLocalModelLeanToolNames(params.preserveToolNames);
    return params.tools.filter((tool) => {
      const normalizedName = normalizeToolName(tool.name);
      return (
        preservedToolNames.has(normalizedName) ||
        LOCAL_MODEL_LEAN_STRICT_ALLOW_TOOL_NAMES.has(normalizedName)
      );
    });
  }
  const denyToolNames = LOCAL_MODEL_LEAN_BASIC_DENY_TOOL_NAMES;
  const preservedToolNames = resolvePreservedLocalModelLeanToolNames(params.preserveToolNames);
  return params.tools.filter((tool) => {
    const normalizedName = normalizeToolName(tool.name);
    return preservedToolNames.has(normalizedName) || !denyToolNames.has(normalizedName);
  });
}
