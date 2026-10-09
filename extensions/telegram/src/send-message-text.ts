import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { renderTelegramHtmlText } from "./format.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import type { TelegramOutboundPromptContextMessage as TelegramMessageLike } from "./outbound-message-context.js";
import type { TelegramRichMessageContextParams } from "./rich-message.js";
import { isTelegramEmptyContentError } from "./rich-plain-fallback.js";
import {
  logTelegramOutboundSendOk,
  resolveAcceptedReplyToMessageId,
  sendLogger,
  toAcceptedThreadScopedParams,
  type TelegramApi,
  type TelegramThreadScopedParams,
} from "./send-context.js";
import type { TelegramSendOpts, TelegramSendResult } from "./send-message-types.js";
import type { reportTelegramProviderDelivery } from "./send-outbound.js";
import type { TelegramPreparedSender } from "./send-prepared.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { planTelegramTextDeliveryPages } from "./telegram-text-delivery.js";
import { resolveTelegramTextChunkLimit } from "./text-chunk-limit.js";

export type TelegramDeliveryReporter = (
  params: Omit<
    Parameters<typeof reportTelegramProviderDelivery>[0],
    "successfulSendThread" | "onDeliveryResult"
  >,
) => Promise<TelegramSendResult>;

type SendTextOptions = {
  replyToAlreadyUsed?: boolean;
  beforeFirstAccepted?: () => Promise<void>;
};

export function createTelegramTextSender(config: {
  cfg: OpenClawConfig;
  ownerAgentId: string;
  account: ResolvedTelegramAccount;
  api: TelegramApi;
  chatId: string;
  opts: TelegramSendOpts;
  replyMarkup: ReturnType<typeof buildInlineKeyboard>;
  reportDelivery: TelegramDeliveryReporter;
  recordDeliveredPromptContext: (
    params: Omit<
      Parameters<typeof recordOutboundMessageForPromptContext>[0],
      "cfg" | "account" | "botUserId" | "chatId" | "promptContextProjection"
    >,
    finalPart: boolean,
  ) => Promise<void>;
  singleUseReplyTo: boolean;
  buildThreadParams: (includeReplyTo: boolean) => Record<string, unknown>;
  sender: TelegramPreparedSender;
  textMode: "markdown" | "html";
  tableMode: MarkdownTableMode;
  useRichMessages: boolean;
}) {
  const {
    cfg,
    ownerAgentId,
    account,
    api,
    chatId,
    opts,
    replyMarkup,
    reportDelivery,
    recordDeliveredPromptContext,
    singleUseReplyTo,
    buildThreadParams,
    sender,
    textMode,
    tableMode,
    useRichMessages,
  } = config;

  const linkPreviewOptions =
    account.config.linkPreview === false ? { is_disabled: true } : undefined;

  return async (
    rawText: string,
    context: string,
    options: SendTextOptions = {},
  ): Promise<TelegramSendResult> => {
    type PendingChunk = {
      result: TelegramMessageLike;
      messageId: number;
      acceptedParams?: TelegramThreadScopedParams | TelegramRichMessageContextParams;
      plainText: string;
      reportChatId: string | number;
      hasInlineKeyboard: boolean;
    };

    const start = sender.parts.length;
    let acceptedReplyToMessageId: number | undefined;
    const deliveryResults: TelegramSendResult[] = [];
    const buildReceipt = () => {
      if (deliveryResults.length === 0) {
        return undefined;
      }
      if (deliveryResults.length === 1) {
        return deliveryResults[0]?.receipt;
      }
      const receipt = createMessageReceiptFromOutboundResults({
        results: deliveryResults,
        kind: "text",
        ...(typeof acceptedReplyToMessageId === "number"
          ? { replyToId: String(acceptedReplyToMessageId) }
          : {}),
      });
      receipt.parts = receipt.parts.map((part, index) => ({ ...part, index }));
      return receipt;
    };
    let pendingChunk: PendingChunk | undefined;
    let finalMeta: TelegramSendResult["meta"] | undefined;

    const flushChunk = async (chunk: PendingChunk, finalPart: boolean) => {
      let keyboardError: unknown;
      if (finalPart && replyMarkup && !chunk.hasInlineKeyboard) {
        try {
          await api.editMessageReplyMarkup(chunk.reportChatId, chunk.messageId, {
            reply_markup: replyMarkup,
          });
          finalMeta = {
            telegramDeliveredText: chunk.plainText,
            telegramHasInlineKeyboard: true,
          };
        } catch (error) {
          keyboardError = error;
        }
      }
      await recordDeliveredPromptContext(
        {
          message: chunk.result,
          messageId: chunk.messageId,
          text: chunk.plainText,
          ...(chunk.acceptedParams?.message_thread_id !== undefined
            ? { messageThreadId: chunk.acceptedParams.message_thread_id }
            : {}),
        },
        finalPart,
      );
      if (keyboardError !== undefined) {
        // Finalization routes this through sender.fail(), which preserves the
        // accepted message IDs in a partial-delivery error.
        if (keyboardError instanceof Error) {
          throw keyboardError;
        }
        throw new Error(formatErrorMessage(keyboardError));
      }
    };

    const flushPending = async (finalPart: boolean) => {
      const chunk = pendingChunk;
      pendingChunk = undefined;
      if (chunk) {
        await flushChunk(chunk, finalPart);
      }
    };

    const record = async (params: Omit<PendingChunk, "reportChatId">) => {
      const { messageId } = params;
      acceptedReplyToMessageId ??= resolveAcceptedReplyToMessageId(params.acceptedParams);
      if (sender.parts.length === start + 1) {
        await options.beforeFirstAccepted?.();
      }
      await recordSentMessage(chatId, messageId, cfg, {
        accountId: account.accountId,
        agentId: ownerAgentId,
      });
      await reportDelivery({
        messageId,
        fallbackChatId: params.result?.chat?.id ?? chatId,
        message: params.result,
        meta: {
          telegramDeliveredText: params.plainText,
          telegramHasInlineKeyboard: params.hasInlineKeyboard,
        },
        kind: "text",
        onPrepared: (delivery) => deliveryResults.push(delivery),
      });
      const previousChunk = pendingChunk;
      pendingChunk = {
        ...params,
        reportChatId: params.result?.chat?.id ?? chatId,
      };
      if (previousChunk) {
        await flushChunk(previousChunk, false);
      }
    };

    const partialDeliveryResult = () => {
      const receipt = buildReceipt();
      return receipt ? { receipt } : {};
    };

    const tracking = {
      invalidate: () => opts.promptContextProjectionPlan?.cursor.invalidate(),
      onRejected: (error: unknown) =>
        logVerbose(
          `telegram ${context} text chunk rejected; continuing: ${formatErrorMessage(error)}`,
        ),
      onSilentSkip: (error: unknown) =>
        logVerbose(
          `telegram ${context} text chunk rendered empty; skipping: ${formatErrorMessage(error)}`,
        ),
      partialDeliveryResult,
    };
    const alreadyUsed = options.replyToAlreadyUsed === true;
    const maxChars = Math.min(
      opts.textLimit ?? Number.POSITIVE_INFINITY,
      resolveTelegramTextChunkLimit({
        cfg,
        accountId: account.accountId,
        ...(textMode === "html" ? { formatting: { parseMode: "HTML" } } : {}),
      }),
    );
    const pages = planTelegramTextDeliveryPages({
      text:
        textMode === "html" ? renderTelegramHtmlText(rawText, { textMode, tableMode }) : rawText,
      maxChars,
      tableMode,
      chunkMode: opts.chunkMode ?? resolveChunkMode(cfg, "telegram", account.accountId),
      richMessages: useRichMessages,
      skipEntityDetection: account.config.linkPreview === false,
      ...(textMode === "html" ? { textMode: "html" as const } : {}),
      warn: (message) => sendLogger.warn(message),
    });
    try {
      await sender.sendText({
        pages,
        context,
        tracking,
        drainFallback: true,
        observe: record,
        preparePage: (index) => ({
          requestParams: (fallback) => {
            const count = Math.max(pages.length, fallback?.count ?? pages.length);
            const includeReply = !alreadyUsed && (!singleUseReplyTo || count === 1);
            const finalPart =
              index === pages.length - 1 && (!fallback || fallback.index === fallback.count - 1);
            return {
              ...buildThreadParams(includeReply),
              ...(finalPart && replyMarkup ? { reply_markup: replyMarkup } : {}),
              ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
              ...(opts.silent === true ? { disable_notification: true } : {}),
            };
          },
        }),
      });
      await flushPending(true);
      const parts = sender.parts.slice(start);
      const last = parts.at(-1);
      const lastMessageId = last ? String(last.messageId) : "";
      const lastChatId = String(last?.result.chat?.id ?? chatId);
      if (lastMessageId) {
        logTelegramOutboundSendOk({
          accountId: account.accountId,
          chatId: lastChatId,
          messageId: lastMessageId,
          operation: useRichMessages ? "sendRichMessage" : "sendMessage",
          deliveryKind: "text",
          messageThreadId: toAcceptedThreadScopedParams(last?.acceptedParams)?.message_thread_id,
          replyToMessageId: opts.replyToMessageId,
          silent: opts.silent,
          chunkCount: parts.length,
        });
      }
      const receipt = buildReceipt();
      return {
        messageId: lastMessageId,
        chatId: lastChatId,
        ...(receipt ? { receipt } : {}),
        ...(finalMeta ? { meta: finalMeta } : {}),
      };
    } catch (error) {
      // Terminal/ambiguous failures escape chunk rejection before its invalidate
      // branch; the projection cursor must not claim clean custody for pages
      // that never landed (main's pre-centralization outer-catch contract).
      if (isChannelPartialDeliveryError(error) || !isTelegramEmptyContentError(error)) {
        opts.promptContextProjectionPlan?.cursor.invalidate();
      }
      try {
        await flushPending(false);
      } catch (flushError) {
        sendLogger.warn(
          `telegram ${context} delivery bookkeeping cleanup failed: ${formatErrorMessage(flushError)}`,
        );
      }
      return sender.fail(error, start, partialDeliveryResult());
    }
  };
}
