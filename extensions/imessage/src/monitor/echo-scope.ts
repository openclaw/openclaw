import type { MediaPlaceholderTextFact } from "openclaw/plugin-sdk/channel-inbound";
import type { SentMessageCache } from "./echo-cache.js";

export type IMessageEchoCache = {
  has: (...args: Parameters<SentMessageCache["has"]>) => boolean | Promise<boolean>;
};

export async function hasIMessageEchoMatch(params: {
  echoCache: IMessageEchoCache;
  scope: readonly string[];
  text?: string;
  media?: MediaPlaceholderTextFact;
  messageIds: string[];
  skipIdShortCircuit?: boolean;
  includePendingText?: boolean;
}): Promise<boolean> {
  // Outbound sends persist echo scopes keyed by whichever target shape was
  // used (chat_id, chat_guid, chat_identifier, or imessage:<handle>). Inbound
  // messages from chat.db typically carry chat_id + chat_guid + chat_identifier
  // for groups and just sender for DMs, so the same conversation can be
  // echo-cached under one shape and re-encountered under another. Probe every
  // candidate scope so a chat_guid-keyed send isn't surfaced back to the agent
  // as a fresh inbound when chat.db only annotates it with chat_id (or
  // vice-versa).
  for (const scope of params.scope) {
    for (const messageId of params.messageIds) {
      if (await params.echoCache.has(scope, { messageId })) {
        return true;
      }
    }
    const fallbackMessageId = params.messageIds[0];
    if (!params.text && !params.media && !fallbackMessageId) {
      continue;
    }
    if (
      await params.echoCache.has(
        scope,
        { text: params.text, media: params.media, messageId: fallbackMessageId },
        {
          skipIdShortCircuit: params.skipIdShortCircuit,
          includePendingText: params.includePendingText,
        },
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Strict reflected-reply probe.
 *
 * Direct replies are dispatched with the provider's exact chat-id target and persisted
 * under that scope, so the probe has to consult every scope the conversation can be
 * keyed by. Scopes are probed in order and short-circuit on the first hit, which keeps
 * the common `imessage:<handle>` case to a single cache read.
 */
export async function hasReflectedReplyEcho(params: {
  echoCache: IMessageEchoCache;
  scopes: readonly string[];
  text: string;
  messageId: string;
}): Promise<boolean> {
  for (const scope of params.scopes) {
    if (
      await params.echoCache.has(
        scope,
        { text: params.text, messageId: params.messageId },
        { requireMessageIdTextMatch: true },
      )
    ) {
      return true;
    }
  }
  return false;
}
