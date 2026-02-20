import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
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
 * Extract provider + user ID from a session key and look up dmHistoryLimit.
 * Supports per-DM overrides and provider defaults.
 * For channel/group sessions, uses historyLimit from provider config.
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
  const userIdRaw = providerParts.slice(2).join(":");
  const userId = stripThreadSuffix(userIdRaw);

  const resolveProviderConfig = (
    cfg: OpenClawConfig | undefined,
    providerId: string,
  ):
    | {
        historyLimit?: number;
        dmHistoryLimit?: number;
        dms?: Record<string, { historyLimit?: number }>;
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
      historyLimit?: number;
      dmHistoryLimit?: number;
      dms?: Record<string, { historyLimit?: number }>;
    };
  };

  const providerConfig = resolveProviderConfig(config, provider);
  if (!providerConfig) {
    return undefined;
  }

  // For DM sessions: per-DM override -> dmHistoryLimit.
  // Accept both "direct" (new) and "dm" (legacy) for backward compat.
  if (kind === "dm" || kind === "direct") {
    if (userId && providerConfig.dms?.[userId]?.historyLimit !== undefined) {
      return providerConfig.dms[userId].historyLimit;
    }
    return providerConfig.dmHistoryLimit;
  }

  // For channel/group sessions: use historyLimit from provider config
  // This prevents context overflow in long-running channel sessions
  if (kind === "channel" || kind === "group") {
    return providerConfig.historyLimit;
  }

  return undefined;
}

/**
 * @deprecated Use getHistoryLimitFromSessionKey instead.
 * Alias for backward compatibility.
 */
export const getDmHistoryLimitFromSessionKey = getHistoryLimitFromSessionKey;
