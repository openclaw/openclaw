/**
 * Inbound message handler for the telegram-userbot channel.
 *
 * Registers GramJS NewMessage event handlers on the underlying TelegramClient
 * and converts MTProto events into typed InboundTelegramMessage objects for
 * consumption by the OpenClaw gateway adapter.
 *
 * Usage (from gateway.startAccount):
 *   const cleanup = registerInboundHandlers(client, { selfUserId, onMessage });
 *   // later, on teardown:
 *   cleanup();
 */

import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import type { Api } from "telegram/tl/index.js";
import type { UserbotClient } from "./client.js";
import { resolveChatType, resolveSenderName, resolveMediaType } from "./helpers.js";
import { normalizeChatId, formatChannelChatId } from "./normalize.js";

// ---------------------------------------------------------------------------
// Config & message types
// ---------------------------------------------------------------------------

export interface InboundHandlerConfig {
  /** The self-user Telegram ID (used for echo-loop prevention). */
  selfUserId: number;
  /** Optional allowlist of sender IDs/usernames. Empty = allow all. */
  allowFrom?: (string | number)[];
  /** Callback invoked for each accepted inbound message. */
  onMessage: (msg: InboundTelegramMessage) => void | Promise<void>;
}

export interface InboundTelegramMessage {
  channel: "telegram-userbot";
  /** Normalized chat ID (string) */
  chatId: string;
  /** Prefixed channel chat ID: "telegram-userbot:12345" */
  channelChatId: string;
  messageId: number;
  text: string;
  senderId: number;
  senderName: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  chatTitle?: string;
  replyToMessageId?: number;
  mediaType?: string;
  isForward?: boolean;
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register event handlers on the GramJS client for inbound messages.
 * Returns a cleanup function that removes all registered handlers.
 */
export function registerInboundHandlers(
  client: UserbotClient,
  config: InboundHandlerConfig,
): () => void {
  const gramClient = client.getClient();

  const handler = async (event: NewMessageEvent) => {
    const message = event.message;
    if (!message) return;

    // Prevent echo loops -- ignore own outgoing messages
    if (message.out) return;

    // Extract sender ID (GramJS can return bigint)
    const senderId = message.senderId ? Number(message.senderId) : 0;
    if (!senderId) return;

    // AllowFrom filtering: when the list is non-empty, only pass matching senders
    if (config.allowFrom && config.allowFrom.length > 0) {
      const allowed = config.allowFrom.some((id) => String(id) === String(senderId));
      if (!allowed) return;
    }

    // Resolve chat and sender entities (best-effort; network may fail)
    let chat: Api.TypeChat | Api.User | undefined;
    try {
      chat = await message.getChat();
    } catch {
      // If entity resolution fails we still process the message
    }

    let sender: Api.User | Api.Channel | Api.Chat | undefined;
    try {
      sender = (await message.getSender()) as Api.User | Api.Channel | Api.Chat | undefined;
    } catch {
      // Fallback: sender info unavailable
    }

    const chatId = message.chatId ? normalizeChatId(message.chatId) : normalizeChatId(senderId);

    const inbound: InboundTelegramMessage = {
      channel: "telegram-userbot",
      chatId,
      channelChatId: formatChannelChatId(chatId),
      messageId: message.id,
      text: message.text || "",
      senderId,
      senderName: resolveSenderName(sender),
      chatType: resolveChatType(chat),
      chatTitle: chat && "title" in chat ? (chat.title as string) : undefined,
      replyToMessageId: message.replyTo?.replyToMsgId,
      mediaType: resolveMediaType(message.media),
      isForward: !!message.fwdFrom,
    };

    await config.onMessage(inbound);
  };

  gramClient.addEventHandler(handler, new NewMessage({}));

  return () => {
    gramClient.removeEventHandler(handler, new NewMessage({}));
  };
}
