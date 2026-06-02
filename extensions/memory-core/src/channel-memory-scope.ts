import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export type ChannelMemoryScopeConfig = {
  enabled?: boolean;
  includeGlobal?: boolean;
  includeAgentPrivate?: boolean;
  requireOverrideReason?: boolean;
  collections?: {
    global?: string;
    agentPrivatePrefix?: string;
    slackChannelPrefix?: string;
    slackDmPrefix?: string;
  };
};

export type MemoryScopeOverride = {
  includeScopes?: string[];
  reason?: string;
};

type ParsedRoute = {
  surface?: string;
  chatType?: "channel" | "group" | "direct";
  targetId?: string;
};

const DEFAULT_GLOBAL_COLLECTION = "memory-global-main";
const DEFAULT_AGENT_PRIVATE_PREFIX = "memory-private-";
const DEFAULT_SLACK_CHANNEL_PREFIX = "memory-slack-";
const DEFAULT_SLACK_DM_PREFIX = "memory-dm-";

export function resolveChannelMemoryQmdCollections(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  override?: MemoryScopeOverride;
}): { enabled: boolean; collectionNames?: string[]; error?: string } {
  const config = resolveChannelMemoryScopeConfig(params.cfg);
  if (!config.enabled) {
    return { enabled: false };
  }

  const route = parseSessionRoute(params.sessionKey);
  const scopeIds = new Set<string>();
  if (config.includeGlobal !== false) {
    scopeIds.add("global");
  }
  if (config.includeAgentPrivate !== false) {
    scopeIds.add(`agent_private:${params.agentId}`);
  }
  if (route.surface === "slack" && route.chatType === "channel" && route.targetId) {
    scopeIds.add(`slack_channel:${route.targetId}`);
  } else if (route.surface === "slack" && route.chatType === "direct" && route.targetId) {
    scopeIds.add(`slack_dm:${params.agentId}:${route.targetId}`);
  }

  const overrideScopes = normalizeScopeIds(params.override?.includeScopes);
  if (overrideScopes.length > 0) {
    const reason = params.override?.reason?.trim();
    if (config.requireOverrideReason !== false && !reason) {
      return { enabled: true, error: "memory scope override requires a reason" };
    }
    for (const scope of overrideScopes) {
      if (!isOverrideScopeAllowed(scope, params.agentId)) {
        return { enabled: true, error: `memory scope override denied for ${scope}` };
      }
      scopeIds.add(scope);
    }
  }

  return {
    enabled: true,
    collectionNames: [...scopeIds].map((scope) => collectionNameForScope(scope, config)),
  };
}

function resolveChannelMemoryScopeConfig(cfg: OpenClawConfig): ChannelMemoryScopeConfig {
  const raw = cfg.memory?.qmd as { channelScopes?: ChannelMemoryScopeConfig } | undefined;
  return raw?.channelScopes ?? {};
}

function parseSessionRoute(sessionKey?: string): ParsedRoute {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey ?? "");
  if (!normalized) {
    return {};
  }
  const parts = normalized.split(":").filter(Boolean);
  const rest = parts[0] === "agent" && parts.length >= 3 ? parts.slice(2) : parts;
  const surface = rest[0];
  const rawChatType = rest[1];
  const targetId = rest[2];
  if (rawChatType === "channel" || rawChatType === "group") {
    return { surface, chatType: "channel", targetId };
  }
  if (rawChatType === "dm" || rawChatType === "direct") {
    return { surface, chatType: "direct", targetId };
  }
  return { surface };
}

function normalizeScopeIds(raw?: string[]): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return [...new Set(raw.map((scope) => normalizeLowercaseStringOrEmpty(scope)).filter(Boolean))];
}

function isOverrideScopeAllowed(scope: string, agentId: string): boolean {
  if (scope === "global") {
    return true;
  }
  if (scope === `agent_private:${agentId}`) {
    return true;
  }
  return scope.startsWith("slack_channel:") || scope.startsWith(`slack_dm:${agentId}:`);
}

function collectionNameForScope(scope: string, config: ChannelMemoryScopeConfig): string {
  const collections = config.collections ?? {};
  if (scope === "global") {
    return sanitizeCollectionName(collections.global ?? DEFAULT_GLOBAL_COLLECTION);
  }
  if (scope.startsWith("agent_private:")) {
    return `${sanitizeCollectionPrefix(collections.agentPrivatePrefix ?? DEFAULT_AGENT_PRIVATE_PREFIX)}${sanitizeCollectionName(scope.slice("agent_private:".length))}`;
  }
  if (scope.startsWith("slack_channel:")) {
    return `${sanitizeCollectionPrefix(collections.slackChannelPrefix ?? DEFAULT_SLACK_CHANNEL_PREFIX)}${sanitizeCollectionName(scope.slice("slack_channel:".length))}`;
  }
  if (scope.startsWith("slack_dm:")) {
    return `${sanitizeCollectionPrefix(collections.slackDmPrefix ?? DEFAULT_SLACK_DM_PREFIX)}${sanitizeCollectionName(scope.slice("slack_dm:".length).replaceAll(":", "-"))}`;
  }
  return sanitizeCollectionName(scope);
}

function sanitizeCollectionName(value: string): string {
  return normalizeLowercaseStringOrEmpty(value)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeCollectionPrefix(value: string): string {
  return normalizeLowercaseStringOrEmpty(value)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/g, "");
}
