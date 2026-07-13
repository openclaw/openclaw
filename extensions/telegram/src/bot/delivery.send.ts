// Telegram plugin module implements delivery.send behavior.
import { type Bot, GrammyError } from "grammy";
import { createTelegramRetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTelegramApiErrorLogging } from "../api-logging.js";
import { isSafeToRetrySendError, isTelegramRateLimitError } from "../network-errors.js";
import {
  buildTelegramSendParams,
  getTelegramNativeQuoteReplyMessageId,
  removeTelegramNativeQuoteParam,
} from "../reply-parameters.js";
import {
  buildTelegramRichMessage,
  getTelegramRichRawApi,
  removeTelegramRichNativeQuoteParam,
  toTelegramRichMessageContextParams,
} from "../rich-message.js";
import { buildInlineKeyboard } from "../send.js";
import type { TelegramThreadSpec } from "./helpers.js";

export { buildTelegramSendParams } from "../reply-parameters.js";

const QUOTE_PARAM_RE = /\bquote not found\b|\bQUOTE_TEXT_INVALID\b|\bquote text invalid\b/i;
const HTML_PARSE_ERROR_RE = /can't parse entities|parse entities|find end of the entity/i;
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
    standardMessage?: { plainText: string };
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
  if (opts?.standardMessage) {
    const sendStandard = async (message: string, parseMode?: "HTML") => {
      const res = await sendTelegramWithThreadFallback({
        operation: "sendMessage",
        runtime,
        thread: opts.thread,
        requestParams: baseParams,
        send: (effectiveParams) =>
          bot.api.sendMessage(chatId, message, {
            ...(parseMode ? { parse_mode: parseMode } : {}),
            ...(opts.linkPreview === false ? { link_preview_options: { is_disabled: true } } : {}),
            ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
            ...effectiveParams,
          }),
      });
      runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id}`);
      return res.message_id;
    };
    if (text === opts.standardMessage.plainText) {
      return await sendStandard(text);
    }
    try {
      return await sendStandard(text, "HTML");
    } catch (err) {
      if (!HTML_PARSE_ERROR_RE.test(formatErrorMessage(err))) {
        throw err;
      }
      runtime.log?.("telegram formatted send failed; retrying without formatting");
      return await sendStandard(opts.standardMessage.plainText);
    }
  }
  const richMessage = buildTelegramRichMessage(text, textMode, {
    skipEntityDetection: opts?.linkPreview === false,
  });
  const richRawApi = getTelegramRichRawApi(bot.api);

  if (!text.trim()) {
    throw new Error("Message must be non-empty for Telegram sends");
  }
  const res = await sendTelegramWithThreadFallback({
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
  return res.message_id;
}
