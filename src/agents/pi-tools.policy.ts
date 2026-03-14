import { getChannelDock } from "../channels/dock.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelGroupToolsPolicy, resolveToolsBySender } from "../config/group-policy.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveThreadParentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveAgentConfig, resolveAgentIdFromSessionKey } from "./agent-scope.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import {
  resolveStoredSubagentCapabilities,
  type SubagentSessionRole,
} from "./subagent-capabilities.js";
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
const SUBAGENT_TOOL_DENY_LEAF = [
  "subagents",
  "sessions_list",
  "sessions_history",
  "sessions_spawn",
];

/**
 * Build the deny list for a sub-agent at a given depth.
 *
 * - Depth 1 with maxSpawnDepth >= 2 (orchestrator): allowed to use sessions_spawn,
 *   subagents, sessions_list, sessions_history so it can manage its children.
 * - Depth >= maxSpawnDepth (leaf): denied subagents, sessions_spawn, and
 *   session management tools.
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

function resolveSubagentDenyListForRole(role: SubagentSessionRole): string[] {
  if (role === "leaf") {
    return [...SUBAGENT_TOOL_DENY_ALWAYS, ...SUBAGENT_TOOL_DENY_LEAF];
  }
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

export function resolveSubagentToolPolicyForSession(
  cfg: OpenClawConfig | undefined,
  sessionKey: string,
): SandboxToolPolicy {
  const configured = cfg?.tools?.subagents?.tools;
  const capabilities = resolveStoredSubagentCapabilities(sessionKey, { cfg });
  const allow = Array.isArray(configured?.allow) ? configured.allow : undefined;
  const alsoAllow = Array.isArray(configured?.alsoAllow) ? configured.alsoAllow : undefined;
  const explicitAllow = new Set(
    [...(allow ?? []), ...(alsoAllow ?? [])].map((toolName) => normalizeToolName(toolName)),
  );
  const deny = [
    ...resolveSubagentDenyListForRole(capabilities.role).filter(
      (toolName) => !explicitAllow.has(normalizeToolName(toolName)),
    ),
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

type ToolScopeContextVariant = {
  channel?: string;
  accountId?: string;
  groupId?: string;
  directId?: string;
  /** For direct/dm: parent directId when session has :thread:/:topic: suffix. Used as fallback when full directId has no config match. */
  directIdParent?: string;
};

function resolveToolScopeContextFromSessionKey(
  sessionKey?: string | null,
): ToolScopeContextVariant & {
  alternate?: ToolScopeContextVariant;
} {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return {};
  }
  const kinds = new Set(["group", "channel", "direct", "dm"]);
  // For group/channel: use parent (strip thread/topic) so we resolve group-level policy.
  // For direct/dm: parse raw first to preserve directIds that contain :thread:/:topic: as part of the ID.
  const baseForGroup = resolveThreadParentSessionKey(raw) ?? raw;
  const parseParts = (input: string) => {
    const parts = input.split(":").filter(Boolean);
    let body = parts[0] === "agent" ? parts.slice(2) : parts;
    if (body[0] === "subagent") {
      body = body.slice(1);
    }
    if (body.length < 2) {
      return [];
    }
    const candidates: Array<{
      channel?: string;
      accountId?: string;
      kind: string;
      scopeId: string;
    }> = [];
    const pushCandidate = (candidate: {
      channel?: string;
      accountId?: string;
      kind: string;
      scopeId: string;
    }) => {
      if (!kinds.has(candidate.kind) || !candidate.scopeId) {
        return;
      }
      if (
        candidates.some(
          (existing) =>
            existing.channel === candidate.channel &&
            existing.accountId === candidate.accountId &&
            existing.kind === candidate.kind &&
            existing.scopeId === candidate.scopeId,
        )
      ) {
        return;
      }
      candidates.push(candidate);
    };
    if (kinds.has(body[0])) {
      pushCandidate({
        channel: undefined,
        kind: body[0],
        scopeId: body.slice(1).join(":").trim(),
      });
      return candidates;
    }
    if (kinds.has(body[1])) {
      pushCandidate({
        channel: body[0].trim().toLowerCase(),
        kind: body[1],
        scopeId: body.slice(2).join(":").trim(),
      });
    }
    if (body.length >= 4 && kinds.has(body[2])) {
      pushCandidate({
        channel: body[0].trim().toLowerCase(),
        accountId: normalizeAccountId(body[1]),
        kind: body[2],
        scopeId: body.slice(3).join(":").trim(),
      });
    }
    return candidates;
  };
  const parsedRaw = parseParts(raw);
  const parsedBase = parseParts(baseForGroup);
  if (parsedRaw.length === 0) {
    return {};
  }
  const toContextVariant = (candidate: {
    channel?: string;
    accountId?: string;
    kind: string;
    scopeId: string;
  }): ToolScopeContextVariant => {
    const baseCandidate = parsedBase.find(
      (entry) =>
        entry.channel === candidate.channel &&
        entry.accountId === candidate.accountId &&
        entry.kind === candidate.kind,
    );
    if (candidate.kind === "group" || candidate.kind === "channel") {
      return {
        channel: candidate.channel,
        accountId: candidate.accountId,
        groupId: baseCandidate?.scopeId ?? candidate.scopeId,
      };
    }
    return {
      channel: candidate.channel,
      accountId: candidate.accountId,
      directId: candidate.scopeId,
      directIdParent:
        baseCandidate && baseCandidate.scopeId !== candidate.scopeId
          ? baseCandidate.scopeId
          : undefined,
    };
  };
  const [primary, alternate] = parsedRaw.map(toContextVariant);
  return alternate ? { ...primary, alternate } : primary;
}

type DirectToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
};

type DirectToolPolicyBySenderConfig = Record<string, DirectToolPolicyConfig>;

type DirectToolPolicyEntry = {
  tools?: DirectToolPolicyConfig;
  toolsBySender?: DirectToolPolicyBySenderConfig;
};

function resolveDirectToolPolicyEntries(
  entries: Record<string, DirectToolPolicyEntry> | undefined,
  directId: string,
): {
  direct?: DirectToolPolicyEntry;
  wildcard?: DirectToolPolicyEntry;
} {
  if (!entries) {
    return {};
  }
  const direct = entries[directId];
  if (direct) {
    return { direct, wildcard: entries["*"] };
  }
  const lowered = directId.toLowerCase();
  const matchKey = Object.keys(entries).find((key) => key !== "*" && key.toLowerCase() === lowered);
  if (matchKey) {
    return { direct: entries[matchKey], wildcard: entries["*"] };
  }
  return { wildcard: entries["*"] };
}

function resolveDirectToolPolicyFromConfig(params: {
  config: OpenClawConfig;
  channel: string;
  directId: string;
  /** Fallback when full directId has no config match (e.g. session has :thread: suffix). */
  directIdParent?: string;
  accountId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
}): { policy?: DirectToolPolicyConfig; rank: number } {
  const channelConfig = params.config.channels?.[params.channel] as
    | {
        accounts?: Record<string, { dms?: Record<string, DirectToolPolicyEntry> }>;
        dms?: Record<string, DirectToolPolicyEntry>;
      }
    | undefined;
  if (!channelConfig) {
    return { rank: 0 };
  }
  const accountEntry = resolveAccountEntry(
    channelConfig.accounts,
    normalizeAccountId(params.accountId),
  ) as { dms?: Record<string, DirectToolPolicyEntry> } | undefined;
  const hasAccountScopedDms =
    accountEntry !== undefined && Object.prototype.hasOwnProperty.call(accountEntry, "dms");
  const entries = hasAccountScopedDms ? accountEntry?.dms : channelConfig.dms;
  const directIdsToTry = [
    params.directId,
    ...(params.directIdParent && params.directIdParent !== params.directId
      ? [params.directIdParent]
      : []),
  ];
  let directEntry: DirectToolPolicyEntry | undefined;
  let wildcardEntry: DirectToolPolicyEntry | undefined;
  for (const did of directIdsToTry) {
    const scopedEntries = resolveDirectToolPolicyEntries(entries, did);
    wildcardEntry ??= scopedEntries.wildcard;
    if (scopedEntries.direct) {
      directEntry = scopedEntries.direct;
      wildcardEntry = scopedEntries.wildcard;
      break;
    }
  }
  if (!directEntry && !wildcardEntry) {
    return { rank: 0 };
  }
  // Precedence is:
  // 1. sender-specific override on the exact DM entry
  // 2. exact DM entry tools
  // 3. sender-specific override on the wildcard DM entry
  // 4. wildcard DM entry tools
  const senderPolicy = resolveToolsBySender({
    toolsBySender: directEntry?.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (senderPolicy && pickSandboxToolPolicy(senderPolicy)) {
    return { policy: senderPolicy, rank: 4 };
  }
  if (directEntry?.tools && pickSandboxToolPolicy(directEntry.tools)) {
    return { policy: directEntry.tools, rank: 3 };
  }
  const wildcardSenderPolicy = resolveToolsBySender({
    toolsBySender: wildcardEntry?.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (wildcardSenderPolicy && pickSandboxToolPolicy(wildcardSenderPolicy)) {
    return { policy: wildcardSenderPolicy, rank: 2 };
  }
  if (wildcardEntry?.tools && pickSandboxToolPolicy(wildcardEntry.tools)) {
    return { policy: wildcardEntry.tools, rank: 1 };
  }
  return { rank: 0 };
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

function resolveExplicitProfileAlsoAllow(tools?: OpenClawConfig["tools"]): string[] | undefined {
  return Array.isArray(tools?.alsoAllow) ? tools.alsoAllow : undefined;
}

function hasExplicitToolSection(section: unknown): boolean {
  return section !== undefined && section !== null;
}

function resolveImplicitProfileAlsoAllow(params: {
  globalTools?: OpenClawConfig["tools"];
  agentTools?: AgentToolsConfig;
}): string[] | undefined {
  const implicit = new Set<string>();
  if (
    hasExplicitToolSection(params.agentTools?.exec) ||
    hasExplicitToolSection(params.globalTools?.exec)
  ) {
    implicit.add("exec");
    implicit.add("process");
  }
  if (
    hasExplicitToolSection(params.agentTools?.fs) ||
    hasExplicitToolSection(params.globalTools?.fs)
  ) {
    implicit.add("read");
    implicit.add("write");
    implicit.add("edit");
  }
  return implicit.size > 0 ? Array.from(implicit) : undefined;
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
  const explicitProfileAlsoAllow =
    resolveExplicitProfileAlsoAllow(agentTools) ?? resolveExplicitProfileAlsoAllow(globalTools);
  const implicitProfileAlsoAllow = resolveImplicitProfileAlsoAllow({ globalTools, agentTools });
  const profileAlsoAllow =
    explicitProfileAlsoAllow || implicitProfileAlsoAllow
      ? Array.from(
          new Set([...(explicitProfileAlsoAllow ?? []), ...(implicitProfileAlsoAllow ?? [])]),
        )
      : undefined;
  return {
    agentId,
    globalPolicy: pickSandboxToolPolicy(globalTools),
    globalProviderPolicy: pickSandboxToolPolicy(providerPolicy),
    agentPolicy: pickSandboxToolPolicy(agentTools),
    agentProviderPolicy: pickSandboxToolPolicy(agentProviderPolicy),
    profile,
    providerProfile: agentProviderPolicy?.profile ?? providerPolicy?.profile,
    // alsoAllow is applied at the profile stage (to avoid being filtered out early).
    profileAlsoAllow,
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
  const config = params.config;
  const sessionContext = resolveToolScopeContextFromSessionKey(params.sessionKey);
  const spawnedContext = resolveToolScopeContextFromSessionKey(params.spawnedBy);
  const channelRaw = params.messageProvider ?? sessionContext.channel ?? spawnedContext.channel;
  const channel = normalizeMessageChannel(channelRaw);
  if (!channel) {
    return undefined;
  }
  const rawDirectCandidates: Array<{
    directId?: string;
    directIdParent?: string;
    accountId?: string | null;
  }> = [
    {
      directId: sessionContext.directId,
      directIdParent: sessionContext.directIdParent,
      accountId: params.accountId ?? sessionContext.accountId ?? spawnedContext.accountId,
    },
    {
      directId: sessionContext.alternate?.directId,
      directIdParent: sessionContext.alternate?.directIdParent,
      accountId:
        params.accountId ?? sessionContext.alternate?.accountId ?? spawnedContext.accountId,
    },
    {
      directId: spawnedContext.directId,
      directIdParent: spawnedContext.directIdParent,
      accountId: params.accountId ?? spawnedContext.accountId ?? sessionContext.accountId,
    },
    {
      directId: spawnedContext.alternate?.directId,
      directIdParent: spawnedContext.alternate?.directIdParent,
      accountId:
        params.accountId ?? spawnedContext.alternate?.accountId ?? sessionContext.accountId,
    },
  ];
  const directCandidates = rawDirectCandidates.filter(
    (
      candidate,
    ): candidate is { directId: string; directIdParent?: string; accountId?: string | null } =>
      typeof candidate.directId === "string" && candidate.directId.length > 0,
  );
  const seenDirectCandidates = new Set<string>();
  const resolveBestDirectPolicy = () => {
    let best: { policy?: SandboxToolPolicy; rank: number; specificity: number } = {
      rank: 0,
      specificity: 0,
    };
    if (params.groupId) {
      return best;
    }
    for (const candidate of directCandidates) {
      const key = `${candidate.accountId ?? ""}\n${candidate.directId}\n${candidate.directIdParent ?? ""}`;
      if (seenDirectCandidates.has(key)) {
        continue;
      }
      seenDirectCandidates.add(key);
      const resolved = resolveDirectToolPolicyFromConfig({
        config,
        channel,
        directId: candidate.directId,
        directIdParent: candidate.directIdParent,
        accountId: candidate.accountId,
        senderId: params.senderId ?? candidate.directIdParent ?? candidate.directId,
        senderName: params.senderName,
        senderUsername: params.senderUsername,
        senderE164: params.senderE164,
      });
      const specificity = candidate.accountId ? 1 : 0;
      if (
        resolved.rank > best.rank ||
        (resolved.rank === best.rank && specificity > best.specificity)
      ) {
        best = {
          policy: pickSandboxToolPolicy(resolved.policy),
          rank: resolved.rank,
          specificity,
        };
      }
    }
    return best;
  };
  const rawGroupCandidates: Array<{ groupId?: string; accountId?: string | null }> = params.groupId
    ? [
        {
          groupId: params.groupId,
          accountId: params.accountId ?? sessionContext.accountId ?? spawnedContext.accountId,
        },
      ]
    : [
        {
          groupId: sessionContext.groupId,
          accountId: params.accountId ?? sessionContext.accountId ?? spawnedContext.accountId,
        },
        {
          groupId: sessionContext.alternate?.groupId,
          accountId:
            params.accountId ?? sessionContext.alternate?.accountId ?? spawnedContext.accountId,
        },
        {
          groupId: spawnedContext.groupId,
          accountId: params.accountId ?? spawnedContext.accountId ?? sessionContext.accountId,
        },
        {
          groupId: spawnedContext.alternate?.groupId,
          accountId:
            params.accountId ?? spawnedContext.alternate?.accountId ?? sessionContext.accountId,
        },
      ];
  const groupCandidates = rawGroupCandidates.filter(
    (candidate): candidate is { groupId: string; accountId?: string | null } =>
      typeof candidate.groupId === "string" && candidate.groupId.length > 0,
  );
  const resolveFirstGroupPolicy = () => {
    if (groupCandidates.length === 0) {
      return undefined;
    }
    const seenGroupCandidates = new Set<string>();
    for (const candidate of groupCandidates) {
      const key = `${candidate.accountId ?? ""}\n${candidate.groupId}`;
      if (seenGroupCandidates.has(key)) {
        continue;
      }
      seenGroupCandidates.add(key);
      let dock;
      try {
        dock = getChannelDock(channel);
      } catch {
        dock = undefined;
      }
      const toolsConfig =
        dock?.groups?.resolveToolPolicy?.({
          cfg: config,
          groupId: candidate.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          accountId: candidate.accountId,
          senderId: params.senderId,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
        }) ??
        resolveChannelGroupToolsPolicy({
          cfg: config,
          channel,
          groupId: candidate.groupId,
          accountId: candidate.accountId,
          senderId: params.senderId,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
        });
      const policy = pickSandboxToolPolicy(toolsConfig);
      if (policy) {
        return policy;
      }
    }
    return undefined;
  };
  const preferredScopeKind = params.groupId
    ? "group"
    : sessionContext.directId
      ? "direct"
      : sessionContext.groupId
        ? "group"
        : spawnedContext.directId
          ? "direct"
          : spawnedContext.groupId
            ? "group"
            : undefined;
  const directResolution = resolveBestDirectPolicy();
  if (preferredScopeKind === "direct") {
    return directResolution.policy;
  }
  if (preferredScopeKind === "group") {
    return resolveFirstGroupPolicy();
  }
  const groupPolicy = resolveFirstGroupPolicy();
  if (groupPolicy) {
    return groupPolicy;
  }
  return directResolution.policy;
}

export function isToolAllowedByPolicies(
  name: string,
  policies: Array<SandboxToolPolicy | undefined>,
) {
  return policies.every((policy) => isToolAllowedByPolicyName(name, policy));
}
