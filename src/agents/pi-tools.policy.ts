import type { OpenClawConfig } from "../config/config.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import { getChannelDock } from "../channels/dock.js";
import {
  resolveChannelDMToolsPolicy,
  resolveChannelGroupToolsPolicy,
} from "../config/group-policy.js";
import { resolveThreadParentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveAgentConfig, resolveAgentIdFromSessionKey } from "./agent-scope.js";
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

    // For exec tool with scoped patterns, require command match
    if (normalized === "exec" && hasExecScoping) {
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

const DEFAULT_SUBAGENT_TOOL_DENY = [
  // Session management - main agent orchestrates
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
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
];

export function resolveSubagentToolPolicy(cfg?: OpenClawConfig): SandboxToolPolicy {
  const configured = cfg?.tools?.subagents?.tools;
  const deny = [
    ...DEFAULT_SUBAGENT_TOOL_DENY,
    ...(Array.isArray(configured?.deny) ? configured.deny : []),
  ];
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

function unionAllow(base?: string[], extra?: string[]) {
  if (!Array.isArray(extra) || extra.length === 0) {
    return base;
  }
  // If the user is using alsoAllow without an allowlist, treat it as additive on top of
  // an implicit allow-all policy.
  if (!Array.isArray(base) || base.length === 0) {
    return Array.from(new Set(["*", ...extra]));
  }
  return Array.from(new Set([...base, ...extra]));
}

function pickToolPolicy(config?: ToolPolicyConfig): SandboxToolPolicy | undefined {
  if (!config) {
    return undefined;
  }
  const allow = Array.isArray(config.allow)
    ? unionAllow(config.allow, config.alsoAllow)
    : Array.isArray(config.alsoAllow) && config.alsoAllow.length > 0
      ? unionAllow(undefined, config.alsoAllow)
      : undefined;
  const deny = Array.isArray(config.deny) ? config.deny : undefined;
  if (!allow && !deny) {
    return undefined;
  }
  return { allow, deny };
}

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
    globalPolicy: pickToolPolicy(globalTools),
    globalProviderPolicy: pickToolPolicy(providerPolicy),
    agentPolicy: pickToolPolicy(agentTools),
    agentProviderPolicy: pickToolPolicy(agentProviderPolicy),
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
    return pickToolPolicy(toolsConfig);
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
  return pickToolPolicy(toolsConfig);
}

export function isToolAllowedByPolicies(
  name: string,
  policies: Array<SandboxToolPolicy | undefined>,
  execCommand?: string,
) {
  return policies.every((policy) => isToolAllowedByPolicyName(name, policy, execCommand));
}
