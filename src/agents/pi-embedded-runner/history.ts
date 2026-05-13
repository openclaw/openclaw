import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { AgentMessage } from "../agent-core-contract.js";
import { normalizeProviderId } from "../provider-id.js";

export type HistoryLimitSessionRouting = {
  channel?: string;
  chatType?: string;
  conversationKind?: string;
  conversationPeerId?: string;
};

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

export function getHistoryLimitForSessionRouting(
  routing: HistoryLimitSessionRouting | undefined,
  config: OpenClawConfig | undefined,
): number | undefined {
  if (!routing || !config) {
    return undefined;
  }

  const provider = normalizeProviderId(routing.channel ?? "");
  if (!provider) {
    return undefined;
  }

  const chatType =
    normalizeChatType(routing.chatType) ?? normalizeChatType(routing.conversationKind);
  const peerId = normalizeOptionalString(routing.conversationPeerId);

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
    for (const [configuredProviderId, value] of Object.entries(
      channels as Record<string, unknown>,
    )) {
      if (normalizeProviderId(configuredProviderId) !== providerId) {
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      return value as {
        historyLimit?: number;
        dmHistoryLimit?: number;
        dms?: Record<string, { historyLimit?: number }>;
      };
    }
    return undefined;
  };

  const providerConfig = resolveProviderConfig(config, provider);
  if (!providerConfig) {
    return undefined;
  }

  if (chatType === "direct") {
    if (peerId && providerConfig.dms?.[peerId]?.historyLimit !== undefined) {
      return providerConfig.dms[peerId].historyLimit;
    }
    return providerConfig.dmHistoryLimit;
  }

  if (chatType === "channel" || chatType === "group") {
    return providerConfig.historyLimit;
  }

  return undefined;
}
