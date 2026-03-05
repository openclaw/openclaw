import type { ChatType, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  escapeRegExp,
  resolveThreadSessionKeys as resolveThreadSessionKeysShared,
} from "openclaw/plugin-sdk";
export { createDedupeCache, formatInboundFromLabel } from "openclaw/plugin-sdk";

export function resolveThreadSessionKeys(params: {
  baseSessionKey: string;
  threadId?: string | null;
  parentSessionKey?: string;
}): { sessionKey: string; parentSessionKey?: string } {
  return resolveThreadSessionKeysShared({
    ...params,
    normalizeThreadId: (threadId) => threadId,
  });
}

export function resolveRuntime(opts: { runtime?: RuntimeEnv }): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

/**
 * Maps Pumble SDK `channelType` values to OpenClaw chat types.
 * Pumble SDK enum: 'SELF' | 'DIRECT' | 'PUBLIC' | 'PRIVATE'
 */
export function channelKind(channelType?: string | null): ChatType {
  if (!channelType) {
    return "channel";
  }
  switch (channelType) {
    case "DIRECT":
    case "DIRECT_MESSAGE":
    case "SELF":
      return "direct";
    case "GROUP":
      return "group";
    default:
      // PUBLIC, PRIVATE, PUBLIC_CHANNEL, PRIVATE_CHANNEL → "channel"
      return "channel";
  }
}

export function channelChatType(kind: ChatType): "direct" | "group" | "channel" {
  if (kind === "direct") {
    return "direct";
  }
  if (kind === "group") {
    return "group";
  }
  return "channel";
}

/**
 * Strip bot mention from inbound message text.
 * Handles two formats:
 *   - Pumble's raw mention syntax: `<<@userId>>` (always present in webhook payloads)
 *   - Display name fallback: `@botname` (case-insensitive, word-boundary)
 * Collapses whitespace after stripping.
 */
export function normalizeMention(
  text: string,
  mention: string | undefined,
  botUserId?: string | null,
): string {
  let result = text;
  // Strip Pumble's <<@userId>> mention syntax
  if (botUserId) {
    result = result.replace(new RegExp(`<<@${escapeRegExp(botUserId)}>>`, "g"), " ");
  }
  // Strip @displayName mention
  if (mention) {
    result = result.replace(new RegExp(`@${escapeRegExp(mention)}\\b`, "gi"), " ");
  }
  return result.replace(/\s+/g, " ").trim();
}

/**
 * Check if a Pumble notification is a system message (join/leave/etc.).
 * Pumble's webhook payload includes a `sys` boolean field — `true` for system
 * messages (member joined/left, topic changed, etc.) and `false` for normal
 * user messages. The `ty` field is the event type (e.g. "NEW_MESSAGE") and is
 * always present, so it cannot be used to distinguish system messages.
 */
export function isSystemMessage(sys?: boolean | null): boolean {
  return sys === true;
}
