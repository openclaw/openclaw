import { getChannelDock } from "../channels/dock.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveChannelDMToolsPolicy,
  resolveChannelGroupToolsPolicy,
} from "../config/group-policy.js";
import { resolveThreadParentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveAgentConfig, resolveAgentIdFromSessionKey } from "./agent-scope.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

type CompiledPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

function compilePattern(pattern: string): CompiledPattern {
  const normalized = normalizeToolName(pattern);
  if (!normalized) {
    return { kind: "exact", value: "" };
  }
  if (normalized === "*") {
    return { kind: "all" };
  }
  if (!normalized.includes("*")) {
    return { kind: "exact", value: normalized };
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    kind: "regex",
    value: new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`),
  };
}

function compilePatterns(patterns?: string[]): CompiledPattern[] {
  if (!Array.isArray(patterns)) {
    return [];
  }
  return expandToolGroups(patterns)
    .map(compilePattern)
    .filter((pattern) => pattern.kind !== "exact" || pattern.value);
}

function matchesAny(name: string, patterns: CompiledPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.kind === "all") {
      return true;
    }
    if (pattern.kind === "exact" && name === pattern.value) {
      return true;
    }
    if (pattern.kind === "regex" && pattern.value.test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an exec command matches a scoped pattern like "exec:gog calendar*"
 */
function matchesScopedExec(
  execCommand: string | undefined,
  patterns: string[] | undefined,
): boolean {
  if (!patterns) {
    return false;
  }
  for (const pattern of patterns) {
    if (!pattern.startsWith("exec:")) {
      continue;
    }
    const commandPattern = pattern.slice(5); // Remove "exec:"
    if (commandPattern === "*") {
      return true;
    }
    if (!execCommand) {
      continue;
    }
    if (commandPattern.endsWith("*")) {
      const prefix = commandPattern.slice(0, -1);
      if (execCommand.startsWith(prefix)) {
        return true;
      }
    } else if (execCommand === commandPattern) {
      return true;
    }
  }
  return false;
}

/**
 * Check if any pattern in the list is a scoped exec pattern (including exec:*)
 */
function hasScopedExecPatterns(patterns: string[] | undefined): boolean {
  if (!patterns) {
    return false;
  }
  return patterns.some((p) => p.startsWith("exec:") && p.length > 5);
}

function makeToolPolicyMatcher(policy: SandboxToolPolicy, execCommand?: string) {
  const deny = compilePatterns(policy.deny);
  const allow = compilePatterns(policy.allow);
  const hasExecScoping = hasScopedExecPatterns(policy.allow);
  return (name: string) => {
    const normalized = normalizeToolName(name);

    // Check deny patterns first (including scoped exec deny)
    if (matchesAny(normalized, deny)) {
      // But allow if there's a scoped exec pattern that matches
      if (normalized === "exec" && execCommand && matchesScopedExec(execCommand, policy.allow)) {
        // Scoped allow overrides general deny
      } else {
        return false;
      }
    }

    if (allow.length === 0) {
      return true;
    }

    // For exec tool with scoped patterns:
    // - If execCommand is provided (execution time): require command match
    // - If execCommand is undefined (tool list build time): allow through for later validation
    if (normalized === "exec" && hasExecScoping) {
      if (execCommand === undefined) {
        // At tool list build time, include exec so execution-time check can validate
        return true;
      }
      return matchesScopedExec(execCommand, policy.allow);
    }

    if (matchesAny(normalized, allow)) {
      return true;
    }
    if (normalized === "apply_patch" && matchesAny("exec", allow)) {
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
  const maxSpawnDepth = cfg?.agents?.defaults?.subagents?.maxSpawnDepth ?? 1;
  const effectiveDepth = typeof depth === "number" && depth >= 0 ? depth : 1;
  const baseDeny = resolveSubagentDenyList(effectiveDepth, maxSpawnDepth);
  const deny = [...baseDeny, ...(Array.isArray(configured?.deny) ? configured.deny : [])];
  const allow = Array.isArray(configured?.allow) ? configured.allow : undefined;
  return { allow, deny };
}

export function isToolAllowedByPolicyName(
  name: string,
  policy?: SandboxToolPolicy,
  execCommand?: string,
): boolean {
  if (!policy) {
    return true;
  }
  return makeToolPolicyMatcher(policy, execCommand)(name);
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

type SessionChannelContext = {
  channel?: string;
  accountId?: string;
  kind?: "group" | "channel" | "direct" | "dm";
  peerId?: string;
};

function resolveGroupContextFromSessionKey(sessionKey?: string | null): SessionChannelContext {
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
  const resolveKind = (value?: string): SessionChannelContext["kind"] => {
    const normalized = value?.trim().toLowerCase();
    if (
      normalized === "group" ||
      normalized === "channel" ||
      normalized === "direct" ||
      normalized === "dm"
    ) {
      return normalized;
    }
    return undefined;
  };
  if (body.length < 3) {
    return {};
  }
  const channel = body[0]?.trim().toLowerCase();
  if (!channel) {
    return {};
  }
  const directKind = resolveKind(body[1]);
  if (directKind) {
    const peerId = body.slice(2).join(":").trim();
    if (!peerId) {
      return {};
    }
    return { channel, kind: directKind, peerId };
  }
  const accountKind = resolveKind(body[2]);
  if (!accountKind) {
    return {};
  }
  const accountId = body[1]?.trim();
  const peerId = body.slice(3).join(":").trim();
  if (!peerId) {
    return {};
  }
  return { channel, accountId, kind: accountKind, peerId };
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
  modelProvider?: string;
  modelId?: string;
}) {
  const agentId = params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined;
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
  const groupId =
    params.groupId ??
    (sessionContext.kind === "group" || sessionContext.kind === "channel"
      ? sessionContext.peerId
      : undefined) ??
    (spawnedContext.kind === "group" || spawnedContext.kind === "channel"
      ? spawnedContext.peerId
      : undefined);
  const channelRaw = params.messageProvider ?? sessionContext.channel ?? spawnedContext.channel;
  const channel = normalizeMessageChannel(channelRaw);
  if (!channel) {
    return undefined;
  }
  const accountId = params.accountId ?? sessionContext.accountId ?? spawnedContext.accountId;
  if (!groupId) {
    const isDirectContext =
      sessionContext.kind === "direct" ||
      sessionContext.kind === "dm" ||
      spawnedContext.kind === "direct" ||
      spawnedContext.kind === "dm" ||
      Boolean(params.senderId || params.senderName || params.senderUsername || params.senderE164);
    if (!isDirectContext) {
      return undefined;
    }
    const senderIdFromSession =
      (sessionContext.kind === "direct" || sessionContext.kind === "dm"
        ? sessionContext.peerId
        : undefined) ??
      (spawnedContext.kind === "direct" || spawnedContext.kind === "dm"
        ? spawnedContext.peerId
        : undefined);
    const toolsConfig = resolveChannelDMToolsPolicy({
      cfg: params.config,
      channel,
      accountId,
      senderId: params.senderId ?? senderIdFromSession,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
    return pickSandboxToolPolicy(toolsConfig);
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
      accountId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    }) ??
    resolveChannelGroupToolsPolicy({
      cfg: params.config,
      channel,
      groupId,
      accountId,
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
  execCommand?: string,
) {
  return policies.every((policy) => isToolAllowedByPolicyName(name, policy, execCommand));
}
