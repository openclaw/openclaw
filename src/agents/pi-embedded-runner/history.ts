import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Extracts tool call IDs from an assistant message's content blocks.
 */
function extractToolCallIds(msg: AgentMessage): Set<string> {
  if (msg.role !== "assistant") return new Set();
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return new Set();

  const ids = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; id?: unknown };
    if (typeof rec.id !== "string" || !rec.id) continue;
    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      ids.add(rec.id);
    }
  }
  return ids;
}

/**
 * Extracts the tool call ID from a toolResult message.
 */
function extractToolResultId(msg: AgentMessage): string | null {
  if (msg.role !== "toolResult") return null;
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) return toolCallId;
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) return toolUseId;
  return null;
}

/**
 * Removes orphaned toolResult messages that reference tool calls not present
 * in any assistant message within the given message list.
 */
function dropOrphanedToolResults(messages: AgentMessage[]): AgentMessage[] {
  // Collect all tool call IDs from assistant messages
  const availableToolCallIds = new Set<string>();
  for (const msg of messages) {
    for (const id of extractToolCallIds(msg)) {
      availableToolCallIds.add(id);
    }
  }

  // Filter out toolResult messages that reference missing tool calls
  return messages.filter((msg) => {
    if (msg.role !== "toolResult") return true;
    const id = extractToolResultId(msg);
    // Keep if we can't determine the ID (defensive) or if the ID exists
    return !id || availableToolCallIds.has(id);
  });
}

/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 *
 * Also removes any orphaned toolResult messages that would reference tool calls
 * from truncated assistant messages, preventing API validation errors.
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
        const truncated = messages.slice(lastUserIndex);
        // Remove any toolResult messages that reference tool calls from truncated
        // assistant messages. This prevents "unexpected tool_use_id" API errors.
        return dropOrphanedToolResults(truncated);
      }
      lastUserIndex = i;
    }
  }
  return messages;
}

/**
 * Extract provider + user ID from a session key and look up dmHistoryLimit.
 * Supports per-DM overrides and provider defaults.
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
  const userIdRaw = providerParts.slice(2).join(":");
  const userId = stripThreadSuffix(userIdRaw);
  if (kind !== "dm") {
    return undefined;
  }

  const getLimit = (
    providerConfig:
      | {
          dmHistoryLimit?: number;
          dms?: Record<string, { historyLimit?: number }>;
        }
      | undefined,
  ): number | undefined => {
    if (!providerConfig) {
      return undefined;
    }
    if (userId && providerConfig.dms?.[userId]?.historyLimit !== undefined) {
      return providerConfig.dms[userId].historyLimit;
    }
    return providerConfig.dmHistoryLimit;
  };

  const resolveProviderConfig = (
    cfg: OpenClawConfig | undefined,
    providerId: string,
  ): { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> } | undefined => {
    const channels = cfg?.channels;
    if (!channels || typeof channels !== "object") {
      return undefined;
    }
    const entry = (channels as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }
    return entry as { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> };
  };

  return getLimit(resolveProviderConfig(config, provider));
}
