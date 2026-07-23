// Telegram plugin module implements delivery.send behavior.
import type { Bot } from "grammy";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { createChannelApiRetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTelegramApiErrorLogging } from "../api-logging.js";
import { markdownToTelegramHtml } from "../format.js";
import { isSafeToRetrySendError, isTelegramRateLimitError } from "../network-errors.js";
import {
  buildTelegramSendParams,
  getTelegramNativeQuoteReplyMessageId,
  isTelegramQuoteParamError,
  removeTelegramNativeQuoteParam,
} from "../reply-parameters.js";
import { TELEGRAM_OUTBOUND_RETRY_AFTER_CAP_MS } from "../retry-after.js";
import type { TelegramRichBlocksDegradationReason } from "../rich-block-model.js";
import {
  buildTelegramRichMarkdownPlan,
  getTelegramRichRawApi,
  isEmptyTelegramRichMessage,
  removeTelegramRichNativeQuoteParam,
  toTelegramRichMessageContextParams,
  type TelegramInputRichMessage,
} from "../rich-message.js";
import {
  buildTelegramPlainFallbackPlan,
  isTelegramEmptyContentError,
  isTelegramHtmlParseError,
  warnTelegramRichBlocksDegradations,
} from "../rich-plain-fallback.js";
import { buildInlineKeyboard } from "../send.js";
import type { TelegramThreadSpec } from "./helpers.js";

export { buildTelegramSendParams } from "../reply-parameters.js";

function createTelegramDeliverySendRetry() {
  return createChannelApiRetryRunner({
    shouldRetry: (err) => isSafeToRetrySendError(err) || isTelegramRateLimitError(err),
    strictShouldRetry: true,
    retryAfterMaxDelayMs: TELEGRAM_OUTBOUND_RETRY_AFTER_CAP_MS,
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
    richMessage?: TelegramInputRichMessage;
    richDegradationReasons?: readonly TelegramRichBlocksDegradationReason[];
    linkPreview?: boolean;
    tableMode?: MarkdownTableMode;
    silent?: boolean;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  },
): Promise<number | undefined> {
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
  const sendPlainFallback = async (plainText: string = fallbackText) => {
    const res = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      thread: opts?.thread,
      requestParams: baseParams,
      send: (effectiveParams) =>
        bot.api.sendMessage(chatId, plainText, {
          ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...effectiveParams,
        }),
    });
    runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id} (plain)`);
    return res.message_id;
  };

  // Caller-authored HTML keeps legacy parse_mode HTML semantics (literal
  // newlines, tag-aware chunking) even on rich accounts.
  if (opts?.richMessages === true && textMode !== "html") {
    const richPlan = opts.richMessage
      ? {
          richMessage: opts.richMessage,
          plainText: fallbackText,
          degradationReasons: opts.richDegradationReasons ?? [],
        }
      : buildTelegramRichMarkdownPlan(text, {
          skipEntityDetection: opts.linkPreview === false,
          tableMode: opts.tableMode,
        });
    warnTelegramRichBlocksDegradations({
      context: "sendRichMessage",
      reasons: richPlan.degradationReasons,
      warn: (message) => runtime.log?.(message),
    });
    if (isEmptyTelegramRichMessage(richPlan.richMessage)) {
      if (!hasFallbackText) {
        // Non-whitespace source (an interrupted turn emitting e.g. `<i></i>`)
        // can render to an empty rich payload with an equally empty plain
        // fallback. Skip silently: the model produced nothing visible, so a
        // thrown error would surface a phantom delivery failure to the user.
        runtime.log?.(
          `telegram sendRichMessage skipped chat=${chatId}: empty rich text and empty plain fallback`,
        );
        return undefined;
      }
      runtime.log?.("telegram sendRichMessage rendered empty; falling back to plain text");
      return await sendPlainFallback();
    }
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
            rich_message: richPlan.richMessage,
            ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
            ...effectiveParams,
          }),
      });
      runtime.log?.(`telegram sendRichMessage ok chat=${chatId} message=${res.message_id}`);
      return res.message_id;
    } catch (err) {
      // Rich HTML that trims non-empty can still reach Telegram as empty
      // visible content; with no plain fallback either, treat the rejection as
      // a silent no-op instead of a user-visible delivery failure.
      if (!hasFallbackText && isTelegramEmptyContentError(err)) {
        runtime.log?.(
          `telegram sendRichMessage skipped chat=${chatId}: Telegram rejected content as empty (${formatErrorMessage(err)})`,
        );
        return undefined;
      }
      const fallbackPlan = buildTelegramPlainFallbackPlan({
        plainText: richPlan.plainText || fallbackText,
        err,
        context: "sendRichMessage",
        warn: (message) => runtime.log?.(message),
      });
      if (!fallbackPlan || !hasFallbackText) {
        throw err;
      }
      return await sendPlainFallback(fallbackPlan.plainText);
    }
  }

  // Markdown can render to empty HTML for syntax-only chunks; recover with plain text.
  if (!htmlText.trim()) {
    if (!hasFallbackText) {
      // Nothing renders and nothing can fall back: skip silently so callers
      // record no delivery instead of surfacing a phantom failure.
      runtime.log?.(
        `telegram sendMessage skipped chat=${chatId}: empty formatted text and empty plain fallback`,
      );
      return undefined;
    }
    return await sendPlainFallback();
  }
  try {
    const res = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      thread: opts?.thread,
      requestParams: baseParams,
      shouldLog: (err) => !isTelegramHtmlParseError(err) && !isTelegramEmptyContentError(err),
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
    const isEmptyTextError = isTelegramEmptyContentError(err);
    if (isTelegramHtmlParseError(err) || isEmptyTextError) {
      if (!hasFallbackText) {
        // HTML that trims non-empty (e.g. `<i></i>`) can still render to zero
        // visible characters on Telegram's side. With no plain fallback there
        // is nothing to deliver, so treat the empty-text 400 as a silent skip;
        // parse errors for real content still throw.
        if (isEmptyTextError) {
          runtime.log?.(
            `telegram sendMessage skipped chat=${chatId}: Telegram rejected text as empty (${errText})`,
          );
          return undefined;
        }
        throw err;
      }
      runtime.log?.(`telegram formatted send failed; retrying without formatting: ${errText}`);
      return await sendPlainFallback();
    }
    throw err;
  }
}
