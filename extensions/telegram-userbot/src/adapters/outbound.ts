/**
 * Outbound adapter for the telegram-userbot channel.
 *
 * Implements `ChannelOutboundAdapter` to deliver agent responses through
 * the user's own Telegram account via GramJS/MTProto.
 */

import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { getConnectionManager } from "../channel.js";
import { TELEGRAM_USERBOT_CHANNEL_ID } from "../config-schema.js";
import { FloodController } from "../flood-control.js";
import { parseChannelChatId } from "../normalize.js";
import { chunkMessage, sendMedia, sendText, TELEGRAM_TEXT_LIMIT } from "../outbound.js";
import { resolveTelegramUserbotAccount } from "./config.js";

// ---------------------------------------------------------------------------
// Per-account FloodController cache
// ---------------------------------------------------------------------------

const floodControllers = new Map<string, FloodController>();

function getOrCreateFloodController(
  accountId: string,
  rateLimit?: {
    messagesPerSecond?: number;
    perChatPerSecond?: number;
    jitterMs?: [number, number];
  },
): FloodController {
  let fc = floodControllers.get(accountId);
  if (!fc) {
    fc = new FloodController({
      globalRate: rateLimit?.messagesPerSecond,
      perChatRate: rateLimit?.perChatPerSecond,
      jitterMs: rateLimit?.jitterMs,
    });
    floodControllers.set(accountId, fc);
  }
  return fc;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const telegramUserbotOutboundAdapter: ChannelOutboundAdapter = {
  /** Direct delivery -- messages are sent immediately via MTProto. */
  deliveryMode: "direct",

  /** Telegram text limit is 4096 characters. */
  textChunkLimit: TELEGRAM_TEXT_LIMIT,

  /** Paragraph/newline-aware chunker. */
  chunker: chunkMessage,

  /**
   * Resolve and normalize the outbound target (chat ID).
   *
   * Accepts raw numeric IDs or prefixed `telegram-userbot:12345` forms.
   */
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim() ?? "";
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Telegram Userbot: missing target. Provide a numeric chat ID or @username.",
        ),
      };
    }

    // Strip channel prefix if present, validate it looks numeric or is a @username
    const stripped = trimmed.replace(/^telegram-userbot:/i, "");
    if (!stripped) {
      return {
        ok: false,
        error: new Error("Telegram Userbot: empty target after prefix removal."),
      };
    }

    return { ok: true, to: stripped };
  },

  /**
   * Send a text message to a Telegram chat.
   */
  sendText: async ({ cfg, to, text, accountId, replyToId }) => {
    const account = resolveTelegramUserbotAccount({ cfg, accountId });
    const manager = getConnectionManager(account.accountId);
    const client = manager?.getClient();
    if (!client) {
      throw new Error(
        `Telegram Userbot: client not connected for account "${account.accountId}". Is the gateway running?`,
      );
    }

    const floodController = getOrCreateFloodController(account.accountId, account.config.rateLimit);
    const numericChatId = parseChannelChatId(to);
    const replyTo = replyToId ? Number(replyToId) : undefined;

    const result = await sendText({
      client,
      floodController,
      chatId: numericChatId,
      text,
      replyTo: Number.isFinite(replyTo) ? replyTo : undefined,
    });

    if (result.error) {
      throw new Error(`Telegram Userbot send failed: ${result.error}`);
    }

    const firstId = result.messageIds[0];
    return {
      channel: TELEGRAM_USERBOT_CHANNEL_ID,
      messageId: firstId != null ? String(firstId) : "",
      chatId: to,
    };
  },

  /**
   * Send a media file (photo, document, voice note) to a Telegram chat.
   *
   * When `mediaUrl` is a remote URL, it is passed as-is to GramJS which
   * handles downloading. Local file paths and Buffers also work.
   */
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
    const account = resolveTelegramUserbotAccount({ cfg, accountId });
    const manager = getConnectionManager(account.accountId);
    const client = manager?.getClient();
    if (!client) {
      throw new Error(
        `Telegram Userbot: client not connected for account "${account.accountId}". Is the gateway running?`,
      );
    }

    if (!mediaUrl) {
      throw new Error("Telegram Userbot: mediaUrl is required for sendMedia.");
    }

    const floodController = getOrCreateFloodController(account.accountId, account.config.rateLimit);
    const numericChatId = parseChannelChatId(to);
    const replyTo = replyToId ? Number(replyToId) : undefined;
    const forceDocument = account.config.capabilities?.forceDocument ?? true;

    const result = await sendMedia({
      client,
      floodController,
      chatId: numericChatId,
      file: mediaUrl,
      caption: text || undefined,
      replyTo: Number.isFinite(replyTo) ? replyTo : undefined,
      forceDocument,
    });

    if (result.error) {
      throw new Error(`Telegram Userbot media send failed: ${result.error}`);
    }

    return {
      channel: TELEGRAM_USERBOT_CHANNEL_ID,
      messageId: result.messageId != null ? String(result.messageId) : "",
      chatId: to,
    };
  },
};
