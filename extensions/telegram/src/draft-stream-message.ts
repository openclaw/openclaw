import type { Bot } from "grammy";
import type { Message, MessageEntity } from "grammy/types";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { withTelegramNativeQuoteFallback } from "./reply-parameters.js";
import {
  removeTelegramRichNativeQuoteParam,
  type TelegramInputRichMessage,
} from "./rich-message.js";
import { warnTelegramRichBlocksDegradations } from "./rich-plain-fallback.js";
import {
  deliverTelegramTextPage,
  type TelegramTextDeliveryPage,
} from "./telegram-text-delivery.js";
import { TELEGRAM_TEXT_CHUNK_LIMIT } from "./text-chunk-limit.js";

export type TelegramDraftPreview = {
  text: string;
  /** A complete progress update can send before a token stream reaches its debounce threshold. */
  complete?: true;
  /** Suppress link cards for this frame without changing the answer policy. */
  linkPreview?: false;
  parseMode?: "HTML";
  richMessage?: TelegramInputRichMessage;
  markdownSource?: {
    text: string;
    tableMode?: MarkdownTableMode;
  };
};

export type TelegramDraftMessageSnapshot = {
  text: string;
  sourceText: string;
  sourceTextMode?: "html" | "markdown";
  replyToMessageId?: number;
};

export function toDraftSnapshot(page: TelegramTextDeliveryPage): TelegramDraftMessageSnapshot {
  return {
    text: page.plainText,
    sourceText: page.sourceText,
    sourceTextMode: page.sourceTextMode,
  };
}

async function deliverDraftPage<T>(params: {
  page: TelegramTextDeliveryPage;
  context: string;
  warn?: (message: string) => void;
  /** A live preview replaces one visible message; its plain fallback stays one bounded send. */
  previewFallback?: boolean;
  send: (
    content: Pick<TelegramDraftPreview, "text" | "parseMode" | "richMessage"> & {
      entities?: MessageEntity[];
    },
  ) => Promise<T>;
  request?: <R>(send: () => Promise<R>) => Promise<R>;
}) {
  const { page } = params;
  if (page.richMessage) {
    warnTelegramRichBlocksDegradations({
      context: params.context,
      reasons: page.degradationReasons ?? [],
      warn: (message) => params.warn?.(message),
    });
  }
  const send = async () => {
    const deliveredPage = { ...page, degradationReasons: undefined };
    const [delivery] = await deliverTelegramTextPage({
      // Preview diagnostics precede request admission; do not emit them again inside it.
      page: deliveredPage,
      html: page.sourceTextMode === "html",
      context: params.context,
      warn: (message) => params.warn?.(message),
      // A preview replaces one message: bound its plain fallback to one chunk.
      fallbackLimit: params.previewFallback ? TELEGRAM_TEXT_CHUNK_LIMIT : Number.MAX_SAFE_INTEGER,
      ...(params.previewFallback ? { singleFallbackPart: true } : {}),
      sender: {
        sendPlain: (text, _fallback, _label, entities) =>
          params.send({ text, ...(entities?.length ? { entities } : {}) }),
        sendHtml: (text) => params.send({ text, parseMode: "HTML" }),
        sendRich: (richMessage) => params.send({ text: page.plainText, richMessage }),
      },
    });
    return {
      message: delivery!.result,
      snapshot: toDraftSnapshot(delivery!.page),
      // The preview shows only the first bounded plain chunk; the remaining
      // content stays deliverable by the final answer's own pagination.
      truncated: Boolean(
        params.previewFallback &&
        page.richMessage &&
        page.plainText.length > TELEGRAM_TEXT_CHUNK_LIMIT &&
        delivery!.page.plainText.length <= TELEGRAM_TEXT_CHUNK_LIMIT,
      ),
    };
  };
  return await (params.request ? params.request(send) : send());
}

export async function editTelegramDraftMessage(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["editMessageText"]>[0];
  messageId: number;
  page: TelegramTextDeliveryPage;
  linkPreviewParams: NonNullable<Parameters<Bot["api"]["editMessageText"]>[3]>;
  request: <T>(send: () => Promise<T>) => Promise<T>;
  warn?: (message: string) => void;
  previewFallback?: boolean;
}): Promise<{ snapshot: TelegramDraftMessageSnapshot; truncated: boolean }> {
  const delivery = await deliverDraftPage<unknown>({
    page: params.page,
    context: "stream preview edit",
    warn: params.warn,
    request: params.request,
    previewFallback: params.previewFallback,
    send: ({ text, parseMode, richMessage, entities }) => {
      if (richMessage) {
        return params.api.raw.editMessageText({
          chat_id: params.chatId,
          message_id: params.messageId,
          rich_message: richMessage,
        });
      }
      const other = {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(entities?.length ? { entities } : {}),
        ...params.linkPreviewParams,
      };
      // Preserve grammY's call shape when no preview options apply.
      return Object.keys(other).length > 0
        ? params.api.editMessageText(params.chatId, params.messageId, text, other)
        : params.api.editMessageText(params.chatId, params.messageId, text);
    },
  });
  return { snapshot: delivery.snapshot, truncated: delivery.truncated };
}

export async function sendTelegramDraftMessage(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  page: TelegramTextDeliveryPage;
  sendMessageParams: Record<string, unknown>;
  linkPreviewParams: Record<string, unknown>;
  assertCurrentSend: () => void;
  warn?: (message: string) => void;
  previewFallback?: boolean;
}) {
  const { chatId, linkPreviewParams, page, assertCurrentSend } = params;
  const sendPlannedMessage = (sendMessageParams: Record<string, unknown>) =>
    deliverDraftPage<Message>({
      page,
      context: "stream preview",
      warn: params.warn,
      previewFallback: params.previewFallback,
      send: ({ text, parseMode, richMessage, entities }) => {
        assertCurrentSend();
        return richMessage
          ? params.api.raw.sendRichMessage({
              chat_id: chatId,
              rich_message: richMessage,
              ...sendMessageParams,
            })
          : params.api.sendMessage(chatId, text, {
              ...(parseMode ? { parse_mode: parseMode } : {}),
              ...(entities?.length ? { entities } : {}),
              ...sendMessageParams,
              ...linkPreviewParams,
            });
      },
    });
  const delivery = await withTelegramNativeQuoteFallback({
    label: "stream-preview",
    requestParams: params.sendMessageParams,
    ...(params.page.richMessage
      ? { removeNativeQuoteParam: removeTelegramRichNativeQuoteParam }
      : {}),
    request: sendPlannedMessage,
  });
  return delivery.result;
}
