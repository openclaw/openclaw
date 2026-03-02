/**
 * Outbound message helpers for the telegram-userbot channel.
 *
 * Provides text chunking, flood-controlled sendText and sendMedia primitives
 * used by the ChannelOutboundAdapter (adapters/outbound.ts).
 */

import type { UserbotClient } from "./client.js";
import { wrapGramJSError } from "./errors.js";
import type { FloodController } from "./flood-control.js";
import { parseChannelChatId } from "./normalize.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Telegram's per-message text limit (4096 UTF-16 code units). */
export const TELEGRAM_TEXT_LIMIT = 4096;

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

/**
 * Split a long message into chunks at paragraph/newline/space boundaries.
 *
 * Prefers splitting at paragraph breaks (`\n\n`), then newlines, then spaces,
 * and finally does a hard cut when no break point exists within the limit.
 */
export function chunkMessage(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Find best split point: paragraph break, then newline, then space, then hard cut
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt <= 0) splitAt = limit;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Send text
// ---------------------------------------------------------------------------

export interface SendTextParams {
  client: UserbotClient;
  floodController: FloodController;
  chatId: string | number;
  text: string;
  replyTo?: number;
  parseMode?: "html" | "md";
  /** Override the default chunk limit (for testing). */
  chunkLimit?: number;
}

export interface SendTextResult {
  messageIds: number[];
  error?: string;
}

/**
 * Send a text message with automatic chunking and flood control.
 *
 * Long messages are split via `chunkMessage()`. Each chunk is sent sequentially
 * after acquiring a flood-control token. Only the first chunk carries the
 * `replyTo` reference so the reply thread looks natural.
 */
export async function sendText(params: SendTextParams): Promise<SendTextResult> {
  const { client, floodController, chatId, text, replyTo, parseMode, chunkLimit } = params;
  const numericChatId = typeof chatId === "string" ? parseChannelChatId(chatId) : chatId;
  const chunks = chunkMessage(text, chunkLimit);
  const messageIds: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      await floodController.acquire(String(numericChatId));
      const result = await client.sendMessage(numericChatId, chunks[i], {
        replyTo: i === 0 ? replyTo : undefined,
        parseMode,
      });
      messageIds.push(result.messageId);
    } catch (err) {
      const wrapped = wrapGramJSError(err);
      return { messageIds, error: wrapped.message };
    }
  }

  return { messageIds };
}

// ---------------------------------------------------------------------------
// Send media
// ---------------------------------------------------------------------------

export interface SendMediaParams {
  client: UserbotClient;
  floodController: FloodController;
  chatId: string | number;
  file: string | Buffer;
  caption?: string;
  replyTo?: number;
  forceDocument?: boolean;
  voiceNote?: boolean;
}

export interface SendMediaResult {
  messageId?: number;
  error?: string;
}

/**
 * Send a media file (photo, document, voice note) with flood control.
 */
export async function sendMedia(params: SendMediaParams): Promise<SendMediaResult> {
  const { client, floodController, chatId, file, caption, replyTo, forceDocument, voiceNote } =
    params;
  const numericChatId = typeof chatId === "string" ? parseChannelChatId(chatId) : chatId;

  try {
    await floodController.acquire(String(numericChatId));
    const result = await client.sendFile(numericChatId, file, {
      caption,
      replyTo,
      forceDocument,
      voiceNote,
    });
    return { messageId: result.messageId };
  } catch (err) {
    const wrapped = wrapGramJSError(err);
    return { error: wrapped.message };
  }
}
