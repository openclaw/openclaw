// Telegram plugin module implements delivery.send behavior.
import { type Bot, GrammyError } from "grammy";
import type { MarkdownTableMode, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { createTelegramRetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTelegramApiErrorLogging } from "../api-logging.js";
import {
  escapeTelegramHtml,
  markdownToTelegramChunks,
  renderTelegramHtmlText,
  splitTelegramHtmlChunks,
  telegramHtmlToPlainTextFallback,
} from "../format.js";
import { isSafeToRetrySendError, isTelegramRateLimitError } from "../network-errors.js";
import {
  buildTelegramSendParams,
  getTelegramNativeQuoteReplyMessageId,
  removeTelegramNativeQuoteParam,
} from "../reply-parameters.js";
import { buildInlineKeyboard } from "../send.js";
import type { TelegramThreadSpec } from "./helpers.js";

export { buildTelegramSendParams } from "../reply-parameters.js";

const QUOTE_PARAM_RE = /\bquote not found\b|\bQUOTE_TEXT_INVALID\b|\bquote text invalid\b/i;
const TELEGRAM_TEXT_CHUNK_LIMIT = 4096;
const TELEGRAM_REPLY_PARAM_KEYS = [
  "reply_parameters",
  "reply_to_message_id",
  "allow_sending_without_reply",
] as const;
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

function stripTelegramReplyContext(params: Record<string, unknown>): Record<string, unknown> {
  const stripped = { ...params };
  for (const key of TELEGRAM_REPLY_PARAM_KEYS) {
    delete stripped[key];
  }
  return stripped;
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
    tableMode?: MarkdownTableMode;
    silent?: boolean;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
    replyToMode?: ReplyToMode;
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
  const messageParams = baseParams;
  const textMode = opts?.textMode ?? "markdown";

  if (!text.trim()) {
    throw new Error("Message must be non-empty for Telegram sends");
  }

  const buildChunks = () => {
    if (textMode === "html") {
      const html = renderTelegramHtmlText(text, { textMode, tableMode: opts?.tableMode });
      return splitTelegramHtmlChunks(html, TELEGRAM_TEXT_CHUNK_LIMIT).map((chunk) => ({
        html: chunk,
        plainText: telegramHtmlToPlainTextFallback(chunk),
      }));
    }
    const chunks = markdownToTelegramChunks(text, TELEGRAM_TEXT_CHUNK_LIMIT, {
      tableMode: opts?.tableMode,
    }).map((chunk) => ({ html: chunk.html, plainText: chunk.text }));
    if (chunks.length > 0) {
      return chunks;
    }
    const fallbackHtml = escapeTelegramHtml(text);
    return splitTelegramHtmlChunks(fallbackHtml, TELEGRAM_TEXT_CHUNK_LIMIT).map((chunk) => ({
      html: chunk,
      plainText: telegramHtmlToPlainTextFallback(chunk),
    }));
  };

  const chunks = buildChunks();
  let lastMessageId = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk) {
      continue;
    }
    const isLastChunk = index === chunks.length - 1;
    const visibleChunkParams =
      index === 0 || opts?.replyToMode === "all"
        ? messageParams
        : stripTelegramReplyContext(messageParams);
    const res = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      thread: opts?.thread,
      requestParams: visibleChunkParams,
      send: (effectiveParams) =>
        bot.api.sendMessage(chatId, chunk.html, {
          parse_mode: "HTML",
          ...(opts?.linkPreview === false ? { link_preview_options: { is_disabled: true } } : {}),
          ...(isLastChunk && opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...effectiveParams,
        }),
    });
    lastMessageId = res.message_id;
  }
  runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${lastMessageId}`);
  return lastMessageId;
}
