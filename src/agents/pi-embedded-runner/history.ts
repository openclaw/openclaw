import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

/**
 * Default history limit for group sessions (generous — preserves context).
 * Only kicks in when no per-group or per-provider override is configured.
 */
const DEFAULT_GROUP_HISTORY_LIMIT = 50;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running sessions.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        return messages.slice(lastUserIndex);
      }
      lastUserIndex = i;
    }
  }
  return messages;
}

type ProviderChannelConfig = {
  dmHistoryLimit?: number;
  groupHistoryLimit?: number;
  dms?: Record<string, { historyLimit?: number }>;
  groups?: Record<string, { historyLimit?: number }>;
};

function resolveProviderConfig(
  cfg: OpenClawConfig | undefined,
  providerId: string,
): ProviderChannelConfig | undefined {
  const channels = cfg?.channels;
  if (!channels || typeof channels !== "object") {
    return undefined;
  }
  const entry = (channels as Record<string, unknown>)[providerId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  return entry as ProviderChannelConfig;
}

/**
 * Resolve history limit from a session key.
 * Supports DMs, groups, and per-entity overrides.
 * Groups get a generous default (50 turns) to prevent unbounded accumulation
 * while preserving high-quality context.
 */
export function getHistoryLimitFromSessionKey(
  sessionKey: string | undefined,
  config: OpenClawConfig | undefined,
): number | undefined {
  if (!sessionKey || !config) {
    return undefined;
  }

  const parts = sessionKey.split(":").filter(Boolean);
  const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;

  const provider = providerParts[0]?.toLowerCase();
  if (!provider) {
    return undefined;
  }

  const kind = providerParts[1]?.toLowerCase();
  const entityIdRaw = providerParts.slice(2).join(":");
  const entityId = stripThreadSuffix(entityIdRaw);
  const providerConfig = resolveProviderConfig(config, provider);

  if (kind === "dm") {
    if (entityId && providerConfig?.dms?.[entityId]?.historyLimit !== undefined) {
      return providerConfig.dms[entityId].historyLimit;
    }
    return providerConfig?.dmHistoryLimit;
  }

  if (kind === "group" || kind === "supergroup" || kind === "channel") {
    if (entityId && providerConfig?.groups?.[entityId]?.historyLimit !== undefined) {
      return providerConfig.groups[entityId].historyLimit;
    }
    return providerConfig?.groupHistoryLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
  }

  return undefined;
}

/** @deprecated Use getHistoryLimitFromSessionKey instead. */
export function getDmHistoryLimitFromSessionKey(
  sessionKey: string | undefined,
  config: OpenClawConfig | undefined,
): number | undefined {
  return getHistoryLimitFromSessionKey(sessionKey, config);
}
