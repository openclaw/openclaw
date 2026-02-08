import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

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

/**
 * Extract provider + chat type from a session key and look up persistent session history limit.
 * Supports per-DM overrides and provider defaults for both DMs and groups.
 */
export function getDmHistoryLimitFromSessionKey(
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
  const chatIdRaw = providerParts.slice(2).join(":");
  const chatId = stripThreadSuffix(chatIdRaw);

  // Only handle DMs and groups - other session types don't use this limit
  if (kind !== "dm" && kind !== "group") {
    return undefined;
  }

  const getLimit = (
    providerConfig:
      | {
          dmHistoryLimit?: number;
          groupHistoryLimit?: number;
          dms?: Record<string, { historyLimit?: number }>;
          groups?: Record<string, { historyLimit?: number }>;
        }
      | undefined,
  ): number | undefined => {
    if (!providerConfig) {
      return undefined;
    }

    // Handle DMs
    if (kind === "dm") {
      if (chatId && providerConfig.dms?.[chatId]?.historyLimit !== undefined) {
        return providerConfig.dms[chatId].historyLimit;
      }
      return providerConfig.dmHistoryLimit;
    }

    // Handle groups
    if (kind === "group") {
      if (chatId && providerConfig.groups?.[chatId]?.historyLimit !== undefined) {
        return providerConfig.groups[chatId].historyLimit;
      }
      return providerConfig.groupHistoryLimit;
    }

    return undefined;
  };

  const resolveProviderConfig = (
    cfg: OpenClawConfig | undefined,
    providerId: string,
  ):
    | {
        dmHistoryLimit?: number;
        groupHistoryLimit?: number;
        dms?: Record<string, { historyLimit?: number }>;
        groups?: Record<string, { historyLimit?: number }>;
      }
    | undefined => {
    const channels = cfg?.channels;
    if (!channels || typeof channels !== "object") {
      return undefined;
    }
    const entry = (channels as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }
    return entry as {
      dmHistoryLimit?: number;
      groupHistoryLimit?: number;
      dms?: Record<string, { historyLimit?: number }>;
      groups?: Record<string, { historyLimit?: number }>;
    };
  };

  return getLimit(resolveProviderConfig(config, provider));
}
