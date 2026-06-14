// Telegram plugin module implements delivery.send behavior.
import { type Bot, GrammyError } from "grammy";
import { createTelegramRetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTelegramApiErrorLogging } from "../api-logging.js";
import { renderTelegramHtmlText, telegramHtmlToPlainTextFallback } from "../format.js";
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

const QUOTE_PARAM_RE = /\bquote not found\b|\bQUOTE_TEXT_INVALID\b|\bquote text invalid\b/i;
const GrammyErrorCtor: typeof GrammyError | undefined =
  typeof GrammyError === "function" ? GrammyError : undefined;
const HTML_ENTITY_PARSE_RE = /can't parse entities|parse entities|find end of the entity/i;

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
        `telegram ${params.operation}: native quote rejected; retrying without quote text`,
      );
      const removeNativeQuoteParam =
        params.removeNativeQuoteParam ?? removeTelegramNativeQuoteParam;
      return await sendTelegramWithThreadFallback({
        ...params,
        operation: `${params.operation} (reply retry)`,
        requestParams: removeNativeQuoteParam(params.requestParams),
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
    linkPreview?: boolean;
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
  const richParams = toTelegramRichMessageContextParams(baseParams);
  const textMode = opts?.textMode ?? "markdown";
  const richMessage = buildTelegramRichMessage(text, textMode, {
    skipEntityDetection: opts?.linkPreview === false,
  });

  if (!text.trim()) {
    throw new Error("Message must be non-empty for Telegram sends");
  }
  let res: { message_id: number };
  const legacyTextChunks = () => {
    return splitTelegramRichTextChunks({
      text,
      textLimit: TELEGRAM_LEGACY_TEXT_LIMIT,
      textMode,
      chunkMode: "length",
    });
  };
  const withoutReplyMarkup = (params: Record<string, unknown>) => {
    if (!("reply_markup" in params)) {
      return params;
    }
    const { reply_markup: _replyMarkup, ...rest } = params;
    return rest;
  };
  const sendLegacyTextChunk = async (
    chunk: string,
    index: number,
    chunkCount: number,
    plain: boolean,
  ) => {
    const renderedChunk = renderTelegramHtmlText(chunk, { textMode });
    const textChunk = plain
      ? textMode === "html"
        ? telegramHtmlToPlainTextFallback(renderedChunk)
        : chunk
      : renderedChunk;
    const requestParams = {
      ...baseParams,
      ...(index === chunkCount - 1 && opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      ...(plain ? {} : { parse_mode: "HTML" as const }),
      ...(opts?.linkPreview === false ? { link_preview_options: { is_disabled: true } } : {}),
    };
    return await sendTelegramWithThreadFallback({
      operation: plain ? "sendMessage-plain" : "sendMessage",
      runtime,
      thread: opts?.thread,
      requestParams,
      send: (effectiveParams) =>
        bot.api.sendMessage(
          chatId,
          textChunk,
          index === chunkCount - 1 ? effectiveParams : withoutReplyMarkup(effectiveParams),
        ),
    });
  };
  const sendLegacyTextChunks = async () => {
    let lastRes: { message_id: number } | undefined;
    const chunks = legacyTextChunks();
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? "";
      try {
        lastRes = await sendLegacyTextChunk(chunk, index, chunks.length, false);
      } catch (htmlErr) {
        if (!HTML_ENTITY_PARSE_RE.test(formatErrorMessage(htmlErr))) {
          throw htmlErr;
        }
        lastRes = await sendLegacyTextChunk(chunk, index, chunks.length, true);
      }
    }
    if (!lastRes) {
      throw new Error("Message must be non-empty for Telegram sends");
    }
    return lastRes;
  };
  try {
    const richRawApi = getTelegramRichRawApi(bot.api);
    res = await sendTelegramWithThreadFallback({
      operation: "sendRichMessage",
      runtime,
      thread: opts?.thread,
      requestParams: richParams,
      removeNativeQuoteParam: removeTelegramRichNativeQuoteParam,
      send: (effectiveParams) =>
        richRawApi.sendRichMessage({
          chat_id: chatId,
          rich_message: richMessage,
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...effectiveParams,
        }),
    });
    runtime.log?.(`telegram sendRichMessage ok chat=${chatId} message=${res.message_id}`);
  } catch (err) {
    if (!isTelegramRichMethodUnavailableError(err)) {
      throw err;
    }
    runtime.log?.(
      `telegram sendRichMessage unavailable; retrying via sendMessage: ${formatErrorMessage(err)}`,
    );
    res = await sendLegacyTextChunks();
  }
  return res.message_id;
}
