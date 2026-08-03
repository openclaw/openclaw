import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import type { TelegramOutboundPromptContextMessage as TelegramMessageLike } from "./outbound-message-context.js";
import {
  getTelegramRichRawApi,
  removeTelegramRichNativeQuoteParam,
  TELEGRAM_RICH_TEXT_LIMIT,
  toTelegramRichMessageContextParams,
  type TelegramRichMessageContextParams,
} from "./rich-message.js";
import {
  logTelegramOutboundSendOk,
  resolveAcceptedReplyToMessageId,
  resolveTelegramMessageIdOrThrow,
  sendLogger,
  toAcceptedThreadScopedParams,
  withTelegramNativeQuoteFallback,
  type TelegramApi,
  type TelegramThreadScopedParams,
} from "./send-context.js";
import type {
  TelegramSendMessageParams,
  TelegramSendOpts,
  TelegramSendResult,
} from "./send-message-types.js";
import type { OpenClawConfig } from "./send.runtime.js";
import { recordSentMessage } from "./sent-message-cache.js";
import {
  deliverTelegramTextPage,
  planTelegramTextDeliveryPages,
} from "./telegram-text-delivery.js";

function buildTelegramTextSendReceipt(params: {
  messageIds: readonly string[];
  chatId: string;
  messageThreadId?: number;
  replyToMessageId?: number;
}) {
  if (params.messageIds.length <= 1) {
    return undefined;
  }
  return createMessageReceiptFromOutboundResults({
    results: params.messageIds.map((messageId) => ({ messageId, chatId: params.chatId })),
    kind: "text",
    ...(typeof params.messageThreadId === "number"
      ? { threadId: String(params.messageThreadId) }
      : {}),
    ...(typeof params.replyToMessageId === "number"
      ? { replyToId: String(params.replyToMessageId) }
      : {}),
  });
}

export function createTelegramTextSender(config: {
  cfg: OpenClawConfig;
  account: ResolvedTelegramAccount;
  api: TelegramApi;
  chatId: string;
  opts: TelegramSendOpts;
  replyMarkup: ReturnType<typeof buildInlineKeyboard>;
  reportDelivery: (
    messageId: string | number,
    deliveredChatId: string | number,
    meta?: TelegramSendResult["meta"],
  ) => Promise<void>;
  recordDeliveredPromptContext: (
    params: Omit<
      Parameters<typeof recordOutboundMessageForPromptContext>[0],
      "cfg" | "account" | "botUserId" | "chatId" | "promptContextProjection"
    >,
    finalPart: boolean,
  ) => Promise<void>;
  singleUseReplyTo: boolean;
  buildThreadParams: (includeReplyTo: boolean) => Record<string, unknown>;
  requestWithChatNotFound: <T>(fn: () => Promise<T>, label: string) => Promise<T>;
  textMode: "markdown" | "html";
  tableMode: MarkdownTableMode;
  renderHtmlText: (value: string) => string;
  linkPreviewOptions: { is_disabled: boolean } | undefined;
  useRichMessages: boolean;
}) {
  const {
    cfg,
    account,
    api,
    chatId,
    opts,
    replyMarkup,
    reportDelivery,
    recordDeliveredPromptContext,
    singleUseReplyTo,
    buildThreadParams,
    requestWithChatNotFound,
    textMode,
    tableMode,
    renderHtmlText,
    linkPreviewOptions,
    useRichMessages,
  } = config;

  const shouldIncludeReply = (index: number, count: number, alreadyUsed: boolean) =>
    !alreadyUsed && (!singleUseReplyTo || (count === 1 && index === 0));
  const buildTextParams = (
    index: number,
    count: number,
    finalPart: boolean,
    alreadyUsed: boolean,
  ) => {
    const thread = buildThreadParams(shouldIncludeReply(index, count, alreadyUsed));
    return Object.keys(thread).length || (finalPart && replyMarkup)
      ? { ...thread, ...(finalPart && replyMarkup ? { reply_markup: replyMarkup } : {}) }
      : undefined;
  };
  const buildRichParams = (
    index: number,
    count: number,
    finalPart: boolean,
    alreadyUsed: boolean,
  ) => {
    const thread = toTelegramRichMessageContextParams(
      buildThreadParams(shouldIncludeReply(index, count, alreadyUsed)),
    );
    return Object.keys(thread).length || (finalPart && replyMarkup)
      ? { ...thread, ...(finalPart && replyMarkup ? { reply_markup: replyMarkup } : {}) }
      : undefined;
  };

  const createDelivery = (context: string) => {
    let lastMessageId = "";
    let lastChatId = chatId;
    let lastAcceptedParams:
      | TelegramThreadScopedParams
      | TelegramRichMessageContextParams
      | undefined;
    let acceptedReplyToMessageId: number | undefined;
    const messageIds: string[] = [];
    const record = async (params: {
      result: TelegramMessageLike;
      acceptedParams?: TelegramThreadScopedParams | TelegramRichMessageContextParams;
      plainText: string;
      finalPart: boolean;
    }) => {
      const messageId = resolveTelegramMessageIdOrThrow(params.result, context);
      recordSentMessage(chatId, messageId, cfg);
      await reportDelivery(messageId, params.result.chat?.id ?? chatId, {
        telegramDeliveredText: params.plainText,
        telegramHasInlineKeyboard: params.finalPart && Boolean(replyMarkup),
      });
      await recordDeliveredPromptContext(
        {
          message: params.result,
          messageId,
          text: params.plainText,
          ...(params.acceptedParams?.message_thread_id !== undefined
            ? { messageThreadId: params.acceptedParams.message_thread_id }
            : {}),
        },
        params.finalPart,
      );
      lastMessageId = String(messageId);
      lastChatId = String(params.result.chat?.id ?? chatId);
      lastAcceptedParams = params.acceptedParams;
      acceptedReplyToMessageId ??= resolveAcceptedReplyToMessageId(params.acceptedParams);
      messageIds.push(lastMessageId);
    };
    const finish = (): TelegramSendResult => {
      if (lastMessageId) {
        logTelegramOutboundSendOk({
          accountId: account.accountId,
          chatId: lastChatId,
          messageId: lastMessageId,
          operation: useRichMessages ? "sendRichMessage" : "sendMessage",
          deliveryKind: "text",
          messageThreadId: lastAcceptedParams?.message_thread_id,
          replyToMessageId: opts.replyToMessageId,
          silent: opts.silent,
          chunkCount: messageIds.length,
        });
      }
      const receipt = buildTelegramTextSendReceipt({
        messageIds,
        chatId: lastChatId,
        messageThreadId: lastAcceptedParams?.message_thread_id,
        replyToMessageId: acceptedReplyToMessageId,
      });
      return { messageId: lastMessageId, chatId: lastChatId, ...(receipt ? { receipt } : {}) };
    };
    return { record, finish };
  };

  const requestText = async (
    text: string,
    params: TelegramSendMessageParams | undefined,
    html: boolean,
  ) => {
    const requestParams: TelegramSendMessageParams = {
      ...params,
      ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
      ...(opts.silent === true ? { disable_notification: true } : {}),
      ...(html ? { parse_mode: "HTML" as const } : {}),
    };
    const sent = await withTelegramNativeQuoteFallback({
      label: "message",
      requestParams,
      request: (effectiveParams, label) =>
        requestWithChatNotFound(
          () =>
            Object.keys(effectiveParams).length
              ? api.sendMessage(chatId, text, effectiveParams)
              : api.sendMessage(chatId, text),
          label,
        ),
    });
    return {
      result: sent.result,
      acceptedParams: toAcceptedThreadScopedParams(sent.acceptedParams),
    };
  };

  const sendChunkedText = async (
    rawText: string,
    context: string,
    options: { replyToAlreadyUsed?: boolean } = {},
  ): Promise<TelegramSendResult> => {
    const delivery = createDelivery(context);
    const alreadyUsed = options.replyToAlreadyUsed === true;
    const maxChars = useRichMessages
      ? Math.min(
          resolveTextChunkLimit(cfg, "telegram", account.accountId, {
            fallbackLimit: TELEGRAM_RICH_TEXT_LIMIT,
          }),
          TELEGRAM_RICH_TEXT_LIMIT,
        )
      : 4000;
    const pages = planTelegramTextDeliveryPages({
      text: textMode === "html" ? renderHtmlText(rawText) : rawText,
      maxChars,
      tableMode,
      richMessages: useRichMessages,
      skipEntityDetection: account.config.linkPreview === false,
      ...(textMode === "html" ? { textMode: "html" as const } : {}),
      warn: (message) => sendLogger.warn(message),
    });
    try {
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index]!;
        const lastPage = index === pages.length - 1;
        const accepted = await deliverTelegramTextPage({
          page,
          context,
          warn: (message) => sendLogger.warn(message),
          sender: {
            sendPlain: (plainText, fallback) => {
              const fallbackCount = fallback?.count ?? pages.length;
              const fallbackIndex = fallback
                ? pages.length === 1
                  ? fallback.index
                  : index
                : index;
              const finalPart = lastPage && (!fallback || fallback.index === fallback.count - 1);
              return requestText(
                plainText,
                buildTextParams(
                  fallbackIndex,
                  Math.max(pages.length, fallbackCount),
                  finalPart,
                  alreadyUsed,
                ),
                false,
              );
            },
            sendHtml: (htmlText) =>
              requestText(
                htmlText,
                buildTextParams(index, pages.length, lastPage, alreadyUsed),
                true,
              ),
            sendRich: async (richMessage) => {
              const requestParams = buildRichParams(index, pages.length, lastPage, alreadyUsed);
              const sent = await withTelegramNativeQuoteFallback<TelegramMessageLike>({
                label: "richMessage",
                requestParams: requestParams ?? {},
                removeNativeQuoteParam: removeTelegramRichNativeQuoteParam,
                request: (effectiveParams, label) =>
                  requestWithChatNotFound(
                    () =>
                      getTelegramRichRawApi(api).sendRichMessage({
                        chat_id: chatId,
                        rich_message: richMessage,
                        ...effectiveParams,
                        ...(opts.silent === true ? { disable_notification: true } : {}),
                      }),
                    label,
                  ),
              });
              return {
                result: sent.result,
                acceptedParams: toTelegramRichMessageContextParams(sent.acceptedParams),
              };
            },
          },
        });
        for (let acceptedIndex = 0; acceptedIndex < accepted.length; acceptedIndex += 1) {
          const item = accepted[acceptedIndex]!;
          await delivery.record({
            ...item.result,
            plainText: item.page.plainText,
            finalPart: lastPage && acceptedIndex === accepted.length - 1,
          });
        }
      }
      return delivery.finish();
    } catch (error) {
      opts.promptContextProjectionPlan?.cursor.invalidate();
      throw error;
    }
  };

  return { sendChunkedText };
}
