import { getChannelDock } from "../channels/dock.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelGroupToolsPolicy } from "../config/group-policy.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveThreadParentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveAgentConfig, resolveAgentIdFromSessionKey } from "./agent-scope.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

function makeToolPolicyMatcher(policy: SandboxToolPolicy) {
  const deny = compileGlobPatterns({
    raw: expandToolGroups(policy.deny ?? []),
    normalize: normalizeToolName,
  });
  const allow = compileGlobPatterns({
    raw: expandToolGroups(policy.allow ?? []),
    normalize: normalizeToolName,
  });
  return (name: string) => {
    const normalized = normalizeToolName(name);
    if (matchesAnyGlobPattern(normalized, deny)) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    if (matchesAnyGlobPattern(normalized, allow)) {
      return true;
    }
    if (normalized === "apply_patch" && matchesAnyGlobPattern("exec", allow)) {
      return true;
    }
    return false;
  };
}

/**
 * Tools always denied for sub-agents regardless of depth.
 * These are system-level or interactive tools that sub-agents should never use.
 */
const SUBAGENT_TOOL_DENY_ALWAYS = [
  // System admin - dangerous from subagent
  "gateway",
  "agents_list",
  // Interactive setup - not a task
  "whatsapp_login",
  // Status/scheduling - main agent coordinates
  "session_status",
  "cron",
  // Memory - pass relevant info in spawn prompt instead
  "memory_search",
  "memory_get",
  // Direct session sends - subagents communicate through announce chain
  "sessions_send",
];

/**
 * Additional tools denied for leaf sub-agents (depth >= maxSpawnDepth).
 * These are tools that only make sense for orchestrator sub-agents that can spawn children.
 */
const SUBAGENT_TOOL_DENY_LEAF = ["sessions_list", "sessions_history", "sessions_spawn"];

/**
 * Build the deny list for a sub-agent at a given depth.
 *
 * - Depth 1 with maxSpawnDepth >= 2 (orchestrator): allowed to use sessions_spawn,
 *   subagents, sessions_list, sessions_history so it can manage its children.
 * - Depth >= maxSpawnDepth (leaf): denied sessions_spawn and
 *   session management tools. Still allowed subagents (for list/status visibility).
 */
function resolveSubagentDenyList(depth: number, maxSpawnDepth: number): string[] {
  const isLeaf = depth >= Math.max(1, Math.floor(maxSpawnDepth));
  if (isLeaf) {
    return [...SUBAGENT_TOOL_DENY_ALWAYS, ...SUBAGENT_TOOL_DENY_LEAF];
  }
  // Orchestrator sub-agent: only deny the always-denied tools.
  // sessions_spawn, subagents, sessions_list, sessions_history are allowed.
  return [...SUBAGENT_TOOL_DENY_ALWAYS];
}

export function resolveSubagentToolPolicy(cfg?: OpenClawConfig, depth?: number): SandboxToolPolicy {
  const configured = cfg?.tools?.subagents?.tools;
  const maxSpawnDepth =
    cfg?.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  const effectiveDepth = typeof depth === "number" && depth >= 0 ? depth : 1;
  const baseDeny = resolveSubagentDenyList(effectiveDepth, maxSpawnDepth);
  const allow = Array.isArray(configured?.allow) ? configured.allow : undefined;
  const alsoAllow = Array.isArray(configured?.alsoAllow) ? configured.alsoAllow : undefined;
  const explicitAllow = new Set(
    [...(allow ?? []), ...(alsoAllow ?? [])].map((toolName) => normalizeToolName(toolName)),
  );
  const deny = [
    ...baseDeny.filter((toolName) => !explicitAllow.has(normalizeToolName(toolName))),
    ...(Array.isArray(configured?.deny) ? configured.deny : []),
  ];
  const mergedAllow = allow && alsoAllow ? Array.from(new Set([...allow, ...alsoAllow])) : allow;
  return { allow: mergedAllow, deny };
}

export function isToolAllowedByPolicyName(name: string, policy?: SandboxToolPolicy): boolean {
  if (!policy) {
    return true;
  }
  return makeToolPolicyMatcher(policy)(name);
}

export function filterToolsByPolicy(tools: AnyAgentTool[], policy?: SandboxToolPolicy) {
  if (!policy) {
    return tools;
  }
  const matcher = makeToolPolicyMatcher(policy);
  return tools.filter((tool) => matcher(tool.name));
}

type ToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  profile?: string;
};

function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase();
}

function resolveGroupContextFromSessionKey(sessionKey?: string | null): {
  channel?: string;
  groupId?: string;
} {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return {};
  }
  const base = resolveThreadParentSessionKey(raw) ?? raw;
  const parts = base.split(":").filter(Boolean);
  let body = parts[0] === "agent" ? parts.slice(2) : parts;
  if (body[0] === "subagent") {
    body = body.slice(1);
  }
  if (body.length < 3) {
    return {};
  }
  const [channel, kind, ...rest] = body;
  if (kind !== "group" && kind !== "channel") {
    return {};
  }
  const groupId = rest.join(":").trim();
  if (!groupId) {
    return {};
  }
  return { channel: channel.trim().toLowerCase(), groupId };
}

function resolveProviderToolPolicy(params: {
  byProvider?: Record<string, ToolPolicyConfig>;
  modelProvider?: string;
  modelId?: string;
}): ToolPolicyConfig | undefined {
  const provider = params.modelProvider?.trim();
  if (!provider || !params.byProvider) {
    return undefined;
  }

  const entries = Object.entries(params.byProvider);
  if (entries.length === 0) {
    return undefined;
  }

  const lookup = new Map<string, ToolPolicyConfig>();
  for (const [key, value] of entries) {
    const normalized = normalizeProviderKey(key);
    if (!normalized) {
      continue;
    }
    lookup.set(normalized, value);
  }

  const normalizedProvider = normalizeProviderKey(provider);
  const rawModelId = params.modelId?.trim().toLowerCase();
  const fullModelId =
    rawModelId && !rawModelId.includes("/") ? `${normalizedProvider}/${rawModelId}` : rawModelId;

  const candidates = [...(fullModelId ? [fullModelId] : []), normalizedProvider];

  for (const key of candidates) {
    const match = lookup.get(key);
    if (match) {
      return match;
    }
  }
  return undefined;
}

export function resolveEffectiveToolPolicy(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
}) {
  const explicitAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? normalizeAgentId(params.agentId)
      : undefined;
  const agentId =
    explicitAgentId ??
    (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
  const agentConfig =
    params.config && agentId ? resolveAgentConfig(params.config, agentId) : undefined;
  const agentTools = agentConfig?.tools;
  const globalTools = params.config?.tools;

  const profile = agentTools?.profile ?? globalTools?.profile;
  const providerPolicy = resolveProviderToolPolicy({
    byProvider: globalTools?.byProvider,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const agentProviderPolicy = resolveProviderToolPolicy({
    byProvider: agentTools?.byProvider,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  return {
    agentId,
    globalPolicy: pickSandboxToolPolicy(globalTools),
    globalProviderPolicy: pickSandboxToolPolicy(providerPolicy),
    agentPolicy: pickSandboxToolPolicy(agentTools),
    agentProviderPolicy: pickSandboxToolPolicy(agentProviderPolicy),
    profile,
    providerProfile: agentProviderPolicy?.profile ?? providerPolicy?.profile,
    // alsoAllow is applied at the profile stage (to avoid being filtered out early).
    profileAlsoAllow: Array.isArray(agentTools?.alsoAllow)
      ? agentTools?.alsoAllow
      : Array.isArray(globalTools?.alsoAllow)
        ? globalTools?.alsoAllow
        : undefined,
    providerProfileAlsoAllow: Array.isArray(agentProviderPolicy?.alsoAllow)
      ? agentProviderPolicy?.alsoAllow
      : Array.isArray(providerPolicy?.alsoAllow)
        ? providerPolicy?.alsoAllow
        : undefined,
  };
}

export function resolveGroupToolPolicy(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  spawnedBy?: string | null;
  messageProvider?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
}): SandboxToolPolicy | undefined {
  if (!params.config) {
    return undefined;
  }
  const sessionContext = resolveGroupContextFromSessionKey(params.sessionKey);
  const spawnedContext = resolveGroupContextFromSessionKey(params.spawnedBy);
  const groupId = params.groupId ?? sessionContext.groupId ?? spawnedContext.groupId;
  if (!groupId) {
    return undefined;
  }
  const channelRaw = params.messageProvider ?? sessionContext.channel ?? spawnedContext.channel;
  const channel = normalizeMessageChannel(channelRaw);
  if (!channel) {
    return undefined;
  }
  let dock;
  try {
    dock = getChannelDock(channel);
  } catch {
    dock = undefined;
  }
  const toolsConfig =
    dock?.groups?.resolveToolPolicy?.({
      cfg: params.config,
      groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      accountId: params.accountId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    }) ??
    resolveChannelGroupToolsPolicy({
      cfg: params.config,
      channel,
      groupId,
      accountId: params.accountId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
  return pickSandboxToolPolicy(toolsConfig);
}

export function isToolAllowedByPolicies(
  name: string,
  policies: Array<SandboxToolPolicy | undefined>,
) {
  return policies.every((policy) => isToolAllowedByPolicyName(name, policy));
}
