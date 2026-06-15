// Telegram plugin module implements delivery.send behavior.
import { type Bot, GrammyError } from "grammy";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
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
// Telegram rejects empty-text sends with two known descriptions: the
// long-standing "message text is empty" and the newer "text must be non-empty"
// Bot API variant. Match either so the post-render empty-text skip catches both.
const EMPTY_TEXT_ERR_RE = /message text is empty|text must be non-empty/i;
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
    linkPreview?: boolean;
    tableMode?: MarkdownTableMode;
    silent?: boolean;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  },
): Promise<number | undefined> {
  // Silently skip empty-text sends before any API work. An interrupted
  // mid-reply turn can emit content that collapses to only whitespace after the
  // markdown render + supported-tag filter (a half-emitted code fence, a
  // heading with no body). Telegram rejects those with a 400 ("message text is
  // empty" / "text must be non-empty"), which would surface as a delivery
  // failure even though the model produced nothing visible. Skipping pre-flight
  // returns no message id so callers do not count it as delivered.
  if (!text.trim()) {
    runtime.log?.(`telegram sendMessage skipped chat=${chatId}: empty text after trim`);
    return undefined;
  }
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
    tableMode: opts?.tableMode,
  });
  const richRawApi = getTelegramRichRawApi(bot.api);

  let res: Awaited<ReturnType<typeof richRawApi.sendRichMessage>>;
  try {
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
  } catch (err) {
    // Non-whitespace input can still render to an empty payload through the
    // markdown render + supported-tag filter (e.g. `<i></i>` or a half-emitted
    // code fence). Telegram rejects those with "message text is empty" / "text
    // must be non-empty"; skip silently instead of surfacing a delivery failure
    // and retrying forever for content the model never made visible.
    if (EMPTY_TEXT_ERR_RE.test(formatErrorMessage(err))) {
      runtime.log?.(
        `telegram sendRichMessage skipped chat=${chatId}: Telegram rejected text as empty (${formatErrorMessage(err)})`,
      );
      return undefined;
    }
    throw err;
  }
  runtime.log?.(`telegram sendRichMessage ok chat=${chatId} message=${res.message_id}`);
  return res.message_id;
}
