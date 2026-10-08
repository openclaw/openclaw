import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { escapeTelegramHtml } from "./format.js";
import { withTelegramNativeQuoteFallback } from "./reply-parameters.js";
import {
  removeTelegramRichNativeQuoteParam,
  type TelegramInputRichMessage,
} from "./rich-message.js";
import {
  withTelegramPlainFallback,
  warnTelegramRichBlocksDegradations,
} from "./rich-plain-fallback.js";
import type { TelegramTextDeliveryPage } from "./telegram-text-delivery.js";

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
  plainText: string;
  context: string;
  warn?: (message: string) => void;
  send: (content: Pick<TelegramDraftPreview, "text" | "parseMode" | "richMessage">) => Promise<T>;
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
  const sendFormatted = async () => ({
    message: await params.send(
      page.richMessage
        ? { text: page.plainText, richMessage: page.richMessage }
        : page.sourceTextMode === "html"
          ? { text: page.htmlText ?? page.sourceText, parseMode: "HTML" }
          : { text: params.plainText },
    ),
    snapshot: toDraftSnapshot(page),
  });
  const send = () =>
    page.richMessage || page.sourceTextMode === "html"
      ? withTelegramPlainFallback({
          kind: page.richMessage ? "rich" : "html",
          context: params.context,
          plainText: page.plainText,
          warn: (message) => params.warn?.(message),
          sendFormatted,
          sendPlain: async (plan) => ({
            message: await params.send({ text: plan.plainText }),
            snapshot: {
              text: plan.plainText,
              sourceText: escapeTelegramHtml(plan.plainText),
              sourceTextMode: "html",
            } satisfies TelegramDraftMessageSnapshot,
          }),
        })
      : sendFormatted();
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
}): Promise<TelegramDraftMessageSnapshot> {
  const delivery = await deliverDraftPage<unknown>({
    page: params.page,
    plainText: params.page.sourceText,
    context: "stream preview edit",
    warn: params.warn,
    request: params.request,
    send: ({ text, parseMode, richMessage }) => {
      if (richMessage) {
        return params.api.raw.editMessageText({
          chat_id: params.chatId,
          message_id: params.messageId,
          rich_message: richMessage,
        });
      }
      const other = parseMode
        ? { parse_mode: parseMode, ...params.linkPreviewParams }
        : params.linkPreviewParams;
      // Preserve grammY's call shape when no preview options apply.
      return Object.keys(other).length > 0
        ? params.api.editMessageText(params.chatId, params.messageId, text, other)
        : params.api.editMessageText(params.chatId, params.messageId, text);
    },
  });
  return delivery.snapshot;
}

export async function sendTelegramDraftMessage(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  page: TelegramTextDeliveryPage;
  sendMessageParams: Record<string, unknown>;
  linkPreviewParams: Record<string, unknown>;
  assertCurrentSend: () => void;
  warn?: (message: string) => void;
}) {
  const { chatId, linkPreviewParams, page, assertCurrentSend } = params;
  const sendPlannedMessage = (sendMessageParams: Record<string, unknown>) =>
    deliverDraftPage<Message>({
      page,
      plainText: page.plainText,
      context: "stream preview",
      warn: params.warn,
      send: ({ text, parseMode, richMessage }) => {
        assertCurrentSend();
        return richMessage
          ? params.api.raw.sendRichMessage({
              chat_id: chatId,
              rich_message: richMessage,
              ...sendMessageParams,
            })
          : params.api.sendMessage(chatId, text, {
              ...(parseMode ? { parse_mode: parseMode } : {}),
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
