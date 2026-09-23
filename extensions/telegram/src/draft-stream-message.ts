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

export function fallbackSnapshot(plainText: string): TelegramDraftMessageSnapshot {
  return {
    text: plainText,
    sourceText: escapeTelegramHtml(plainText),
    sourceTextMode: "html",
  };
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
  const { chatId, linkPreviewParams } = params;
  const sendPlannedMessage = async (
    page: TelegramTextDeliveryPage,
    sendMessageParams: Record<string, unknown>,
    assertCurrentSend: () => void,
  ) => {
    const request = <T>(send: () => Promise<T>): Promise<T> => {
      assertCurrentSend();
      return send();
    };
    if (page.richMessage) {
      const richMessage = page.richMessage;
      warnTelegramRichBlocksDegradations({
        context: "stream preview",
        reasons: page.degradationReasons ?? [],
        warn: (message) => params.warn?.(message),
      });
      return await withTelegramPlainFallback<{
        message: Message;
        snapshot: TelegramDraftMessageSnapshot;
      }>({
        kind: "rich",
        context: "stream preview",
        plainText: page.plainText,
        warn: (message) => params.warn?.(message),
        sendFormatted: async () => ({
          message: await request(() =>
            params.api.raw.sendRichMessage({
              chat_id: chatId,
              rich_message: richMessage,
              ...sendMessageParams,
            }),
          ),
          snapshot: toDraftSnapshot(page),
        }),
        sendPlain: async (plan) => ({
          message: await request(() =>
            params.api.sendMessage(chatId, plan.plainText, {
              ...sendMessageParams,
              ...linkPreviewParams,
            }),
          ),
          snapshot: fallbackSnapshot(plan.plainText),
        }),
      });
    }
    if (page.sourceTextMode !== "html") {
      return {
        message: await request(() =>
          params.api.sendMessage(chatId, page.plainText, {
            ...sendMessageParams,
            ...linkPreviewParams,
          }),
        ),
        snapshot: toDraftSnapshot(page),
      };
    }
    return await withTelegramPlainFallback<{
      message: Message;
      snapshot: TelegramDraftMessageSnapshot;
    }>({
      kind: "html",
      context: "stream preview",
      plainText: page.plainText,
      warn: (message) => params.warn?.(message),
      sendFormatted: async () => ({
        message: await request(() =>
          params.api.sendMessage(chatId, page.htmlText ?? page.sourceText, {
            parse_mode: "HTML" as const,
            ...sendMessageParams,
            ...linkPreviewParams,
          }),
        ),
        snapshot: toDraftSnapshot(page),
      }),
      sendPlain: async (plan) => ({
        message: await request(() =>
          params.api.sendMessage(chatId, plan.plainText, {
            ...sendMessageParams,
            ...linkPreviewParams,
          }),
        ),
        snapshot: fallbackSnapshot(plan.plainText),
      }),
    });
  };
  const delivery = await withTelegramNativeQuoteFallback({
    label: "stream-preview",
    requestParams: params.sendMessageParams,
    ...(params.page.richMessage
      ? { removeNativeQuoteParam: removeTelegramRichNativeQuoteParam }
      : {}),
    request: (effectiveParams) =>
      sendPlannedMessage(params.page, effectiveParams, params.assertCurrentSend),
  });
  return delivery.result;
}
