import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope-config.js";
import { resolveProviderToolPolicy } from "./agent-tools.policy.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

const LOCAL_MODEL_LEAN_DENY_TOOL_NAMES = new Set([
  "browser",
  "cron",
  "image_generate",
  "message",
  "music_generate",
  "pdf",
  "tts",
  "video_generate",
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

function collectConfiguredPreservedToolNames(params?: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  modelProvider?: string;
  modelId?: string;
}): string[] {
  const names: string[] = [];
  const collect = (policy?: {
    allow?: string[];
    alsoAllow?: string[];
    byProvider?: Record<string, { allow?: string[]; alsoAllow?: string[] }>;
  }) => {
    if (!policy) {
      return;
    }
    names.push(...(policy?.allow ?? []), ...(policy?.alsoAllow ?? []));
    const providerPolicy = resolveProviderToolPolicy({
      byProvider: policy.byProvider,
      modelProvider: params?.modelProvider,
      modelId: params?.modelId,
    });
    if (providerPolicy) {
      collect(providerPolicy);
    }
  };
  collect(params?.config?.tools);
  const agentId = params?.config ? resolveLocalModelLeanAgentId(params) : undefined;
  if (params?.config && agentId) {
    collect(resolveAgentConfig(params.config, agentId)?.tools);
  }
  return names;
}

export function resolveLocalModelLeanPreserveToolNames(params?: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  modelProvider?: string;
  modelId?: string;
  toolNames?: Iterable<string>;
  forceMessageTool?: boolean;
  sourceReplyDeliveryMode?: string;
}): string[] {
  const names = [...collectConfiguredPreservedToolNames(params), ...(params?.toolNames ?? [])];
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

export function filterLocalModelLeanTools(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  modelProvider?: string;
  modelId?: string;
  preserveToolNames?: Iterable<string>;
}): AnyAgentTool[] {
  if (!isLocalModelLeanEnabled(params)) {
    return params.tools;
  }
  const preservedToolNames = resolvePreservedLocalModelLeanToolNames(
    resolveLocalModelLeanPreserveToolNames({
      config: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      modelProvider: params.modelProvider,
      modelId: params.modelId,
      toolNames: params.preserveToolNames,
    }),
  );
  return params.tools.filter((tool) => {
    const normalizedName = normalizeToolName(tool.name);
    return (
      preservedToolNames.has(normalizedName) ||
      !LOCAL_MODEL_LEAN_DENY_TOOL_NAMES.has(normalizedName)
    );
  });
}
