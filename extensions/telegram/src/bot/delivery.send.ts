// Telegram plugin module implements delivery.send behavior.
import { type Bot, GrammyError } from "grammy";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { createTelegramRetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTelegramApiErrorLogging } from "../api-logging.js";
import { markdownToTelegramHtml, telegramHtmlToPlainTextFallback } from "../format.js";
import {
  isSafeToRetrySendError,
  isTelegramRateLimitError,
  isTelegramRichMethodUnavailableError,
} from "../network-errors.js";
import {
  buildTelegramSendParams,
  getTelegramNativeQuoteReplyMessageId,
  removeTelegramNativeQuoteParam,
} from "../reply-parameters.js";
import {
  buildTelegramRichMessage,
  getTelegramRichRawApi,
  removeTelegramRichNativeQuoteParam,
  splitTelegramRichTextChunks,
  TELEGRAM_LEGACY_TEXT_LIMIT,
  toTelegramRichMessageContextParams,
} from "../rich-message.js";
import { buildInlineKeyboard } from "../send.js";
import type { TelegramThreadSpec } from "./helpers.js";

export { buildTelegramSendParams } from "../reply-parameters.js";

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const EMPTY_TEXT_ERR_RE = /message text is empty/i;
const QUOTE_PARAM_RE = /\bquote not found\b|\bQUOTE_TEXT_INVALID\b|\bquote text invalid\b/i;
const GrammyErrorCtor: typeof GrammyError | undefined =
  typeof GrammyError === "function" ? GrammyError : undefined;

function isTelegramQuoteParamError(err: unknown): boolean {
  if (GrammyErrorCtor && err instanceof GrammyErrorCtor) {
    return QUOTE_PARAM_RE.test(err.description);
  }
  return QUOTE_PARAM_RE.test(formatErrorMessage(err));
}

function createTelegramDeliverySendRetry() {
  return createTelegramRetryRunner({
    shouldRetry: (err) => isSafeToRetrySendError(err) || isTelegramRateLimitError(err),
    strictShouldRetry: true,
  });
}

export async function sendTelegramWithThreadFallback<T>(params: {
  operation: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  requestParams: Record<string, unknown>;
  send: (effectiveParams: Record<string, unknown>) => Promise<T>;
  removeNativeQuoteParam?: (requestParams: Record<string, unknown>) => Record<string, unknown>;
  shouldLog?: (err: unknown) => boolean;
}): Promise<T> {
  const hasNativeQuote = getTelegramNativeQuoteReplyMessageId(params.requestParams) != null;
  const shouldSuppressFirstErrorLog = (err: unknown) =>
    hasNativeQuote && isTelegramQuoteParamError(err);
  const mergedShouldLog = params.shouldLog
    ? (err: unknown) => params.shouldLog!(err) && !shouldSuppressFirstErrorLog(err)
    : (err: unknown) => !shouldSuppressFirstErrorLog(err);
  const requestWithRetry = createTelegramDeliverySendRetry();
  const runLoggedSend = (
    operation: string,
    requestParams: Record<string, unknown>,
    shouldLog?: (err: unknown) => boolean,
  ) =>
    withTelegramApiErrorLogging({
      operation,
      runtime: params.runtime,
      ...(shouldLog ? { shouldLog } : {}),
      fn: () => requestWithRetry(() => params.send(requestParams), operation),
    });

  try {
    return await runLoggedSend(params.operation, params.requestParams, mergedShouldLog);
  } catch (err) {
    if (hasNativeQuote && isTelegramQuoteParamError(err)) {
      params.runtime.log?.(
        `telegram ${params.operation}: native quote rejected; retrying with legacy reply_to_message_id`,
      );
      return await sendTelegramWithThreadFallback({
        ...params,
        operation: `${params.operation} (legacy reply retry)`,
        requestParams: (params.removeNativeQuoteParam ?? removeTelegramNativeQuoteParam)(
          params.requestParams,
        ),
      });
    }
    throw err;
  }
}

export async function sendTelegramText(
  bot: Bot,
  chatId: string,
  text: string,
  runtime: RuntimeEnv,
  opts?: {
    replyToMessageId?: number;
    replyQuoteMessageId?: number;
    replyQuoteText?: string;
    replyQuotePosition?: number;
    replyQuoteEntities?: unknown[];
    thread?: TelegramThreadSpec | null;
    textMode?: "markdown" | "html";
    plainText?: string;
    richMessages?: boolean;
    linkPreview?: boolean;
    tableMode?: MarkdownTableMode;
    silent?: boolean;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  },
): Promise<number> {
  const baseParams = buildTelegramSendParams({
    replyToMessageId: opts?.replyToMessageId,
    replyQuoteMessageId: opts?.replyQuoteMessageId,
    replyQuoteText: opts?.replyQuoteText,
    replyQuotePosition: opts?.replyQuotePosition,
    replyQuoteEntities: opts?.replyQuoteEntities,
    thread: opts?.thread,
    silent: opts?.silent,
  });
  const textMode = opts?.textMode ?? "markdown";
  // Add link_preview_options when link preview is disabled.
  const linkPreviewEnabled = opts?.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };
  const htmlText = textMode === "html" ? text : markdownToTelegramHtml(text);
  const fallbackText = opts?.plainText ?? text;
  const hasFallbackText = fallbackText.trim().length > 0;
  const sendPlainFallback = async () => {
    const res = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      thread: opts?.thread,
      requestParams: baseParams,
      send: (effectiveParams) =>
        bot.api.sendMessage(chatId, fallbackText, {
          ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...effectiveParams,
        }),
    });
    runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id} (plain)`);
    return res.message_id;
  };
  const sendFormattedFallback = async (chunkLegacyFallback = false) => {
    // Markdown can render to empty HTML for syntax-only chunks; recover with plain text.
    if (!htmlText.trim()) {
      if (!hasFallbackText) {
        throw new Error(
          "telegram sendMessage failed: empty formatted text and empty plain fallback",
        );
      }
      return await sendPlainFallback();
    }
    if (chunkLegacyFallback) {
      let lastMessageId: number | undefined;
      const chunks = splitTelegramRichTextChunks({
        text,
        textLimit: TELEGRAM_LEGACY_TEXT_LIMIT,
        textMode,
        chunkMode: "length",
      });
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index] ?? "";
        const chunkHtml = textMode === "html" ? chunk : markdownToTelegramHtml(chunk);
        const chunkPlain = textMode === "html" ? telegramHtmlToPlainTextFallback(chunkHtml) : chunk;
        try {
          const res = await sendTelegramWithThreadFallback({
            operation: "sendMessage",
            runtime,
            thread: opts?.thread,
            requestParams: baseParams,
            shouldLog: (err) => {
              const errText = formatErrorMessage(err);
              return !PARSE_ERR_RE.test(errText) && !EMPTY_TEXT_ERR_RE.test(errText);
            },
            send: (effectiveParams) =>
              bot.api.sendMessage(chatId, chunkHtml, {
                parse_mode: "HTML",
                ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
                ...(index === chunks.length - 1 && opts?.replyMarkup
                  ? { reply_markup: opts.replyMarkup }
                  : {}),
                ...effectiveParams,
              }),
          });
          lastMessageId = res.message_id;
        } catch (err) {
          const errText = formatErrorMessage(err);
          if (!PARSE_ERR_RE.test(errText) && !EMPTY_TEXT_ERR_RE.test(errText)) {
            throw err;
          }
          const res = await sendTelegramWithThreadFallback({
            operation: "sendMessage-plain",
            runtime,
            thread: opts?.thread,
            requestParams: baseParams,
            send: (effectiveParams) =>
              bot.api.sendMessage(chatId, chunkPlain, {
                ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
                ...(index === chunks.length - 1 && opts?.replyMarkup
                  ? { reply_markup: opts.replyMarkup }
                  : {}),
                ...effectiveParams,
              }),
          });
          lastMessageId = res.message_id;
        }
      }
      if (lastMessageId == null) {
        throw new Error(
          "telegram sendMessage failed: empty formatted text and empty plain fallback",
        );
      }
      return lastMessageId;
    }
    try {
      const res = await sendTelegramWithThreadFallback({
        operation: "sendMessage",
        runtime,
        thread: opts?.thread,
        requestParams: baseParams,
        shouldLog: (err) => {
          const errText = formatErrorMessage(err);
          return !PARSE_ERR_RE.test(errText) && !EMPTY_TEXT_ERR_RE.test(errText);
        },
        send: (effectiveParams) =>
          bot.api.sendMessage(chatId, htmlText, {
            parse_mode: "HTML",
            ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
            ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
            ...effectiveParams,
          }),
      });
      runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id}`);
      return res.message_id;
    } catch (err) {
      const errText = formatErrorMessage(err);
      if (PARSE_ERR_RE.test(errText) || EMPTY_TEXT_ERR_RE.test(errText)) {
        if (!hasFallbackText) {
          throw err;
        }
        runtime.log?.(`telegram formatted send failed; retrying without formatting: ${errText}`);
        return await sendPlainFallback();
      }
      throw err;
    }
  };
  if (opts?.richMessages === true) {
    const richMessage = buildTelegramRichMessage(text, textMode, {
      skipEntityDetection: opts.linkPreview === false,
      tableMode: opts.tableMode,
    });
    try {
      const res = await sendTelegramWithThreadFallback({
        operation: "sendRichMessage",
        runtime,
        thread: opts.thread,
        requestParams: toTelegramRichMessageContextParams(baseParams),
        removeNativeQuoteParam: removeTelegramRichNativeQuoteParam,
        send: (effectiveParams) =>
          getTelegramRichRawApi(bot.api).sendRichMessage({
            chat_id: chatId,
            rich_message: richMessage,
            ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
            ...effectiveParams,
          }),
      });
      runtime.log?.(`telegram sendRichMessage ok chat=${chatId} message=${res.message_id}`);
      return res.message_id;
    } catch (err) {
      if (!isTelegramRichMethodUnavailableError(err)) {
        throw err;
      }
      runtime.log?.(
        `telegram sendRichMessage unavailable; retrying via sendMessage: ${formatErrorMessage(
          err,
        )}`,
      );
      return await sendFormattedFallback(true);
    }
  }
  return await sendFormattedFallback();
}
