import { deflateSync } from "node:zlib";
import type { Chat, Message, User } from "grammy/types";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// Bot API 10.4 widget limits: https://core.telegram.org/bots/widgets#limits
export const TELEGRAM_WIDGET_HTML_MAX_BYTES = 32_768;
export const TELEGRAM_WIDGET_HTML_MAX_COMPRESSED_BYTES = 4_096;
export const TELEGRAM_WIDGET_DATA_MAX_BYTES = 1_024;
export const TELEGRAM_WIDGET_CAPTION_MAX_CHARS = 1_024;

export type TelegramSendWidgetParams = {
  chat_id: number | string;
  html: string;
  caption?: string;
  chat_data?: string;
  allow_queries?: boolean;
  message_thread_id?: number;
  disable_notification?: boolean;
  reply_parameters?: { message_id: number };
};

export type TelegramWidgetMessage = Message & {
  widget?: { html: string; chat_data?: string; public_data?: string; id?: string };
};

type TelegramWidgetRawApi = {
  sendWidget(args: TelegramSendWidgetParams, signal?: AbortSignal): Promise<TelegramWidgetMessage>;
  editMessageWidgetData(
    args: { chat_id: number | string; message_id: number; chat_data?: string },
    signal?: AbortSignal,
  ): Promise<true>;
  answerWidgetQuery(
    args: { widget_query_id: string; data?: string },
    signal?: AbortSignal,
  ): Promise<true>;
};

/**
 * grammY 1.46 types stop at Bot API 10.3. Its raw client forwards any method name through the
 * same transformers (throttler, request authority), so only the method typings are added here.
 */
export function telegramWidgetApi(api: { raw: object }): TelegramWidgetRawApi {
  return api.raw as unknown as TelegramWidgetRawApi;
}

export type TelegramWidgetQuery = {
  id: string;
  from: User;
  chat: Chat;
  message_id: number;
  data: string;
};

/** Original-message widget queries only; inline and forwarded widgets carry no chat route. */
export function readTelegramWidgetQuery(update: unknown): TelegramWidgetQuery | undefined {
  const query = isRecord(update) ? update.widget_query : undefined;
  if (!isRecord(query)) {
    return undefined;
  }
  const { id, from, chat, message_id: messageId, data } = query;
  if (
    typeof id !== "string" ||
    !id ||
    !isRecord(from) ||
    typeof from.id !== "number" ||
    !isRecord(chat) ||
    typeof chat.id !== "number" ||
    typeof chat.type !== "string" ||
    typeof messageId !== "number" ||
    typeof data !== "string"
  ) {
    return undefined;
  }
  return {
    id,
    // SAFETY: Telegram's Update schema defines these objects; the fields routing reads are checked above.
    from: from as unknown as User,
    chat: chat as unknown as Chat,
    message_id: messageId,
    data,
  };
}

export function readTelegramWidgetQueryId(update: unknown): string | undefined {
  const query = isRecord(update) ? update.widget_query : undefined;
  return isRecord(query) && typeof query.id === "string" && query.id ? query.id : undefined;
}

/** Telegram counts the zlib level-9 size of the UTF-8 HTML. */
export function measureTelegramWidgetHtml(html: string): {
  bytes: number;
  compressedBytes: number;
} {
  const bytes = Buffer.from(html, "utf8");
  return { bytes: bytes.length, compressedBytes: deflateSync(bytes, { level: 9 }).length };
}
