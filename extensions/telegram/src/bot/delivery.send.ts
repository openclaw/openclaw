import { type Bot, GrammyError } from "grammy";
import type { TelegramInlineButtons } from "../button-types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTelegramApiErrorLogging } from "../api-logging.js";
import { markdownToTelegramHtml } from "../format.js";
import { buildInlineKeyboard, sendMessageTelegram } from "../send.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./helpers.js";

const THREAD_NOT_FOUND_RE = /message thread not found/i;
const GrammyErrorCtor: typeof GrammyError | undefined =
  typeof GrammyError === "function" ? GrammyError : undefined;

function isTelegramThreadNotFoundError(err: unknown): boolean {
  if (GrammyErrorCtor && err instanceof GrammyErrorCtor) {
    return THREAD_NOT_FOUND_RE.test(err.description);
  }
  return THREAD_NOT_FOUND_RE.test(formatErrorMessage(err));
}

function hasMessageThreadIdParam(params: Record<string, unknown> | undefined): boolean {
  if (!params) {
    return false;
  }
  return typeof params.message_thread_id === "number";
}

function removeMessageThreadIdParam(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!params) {
    return {};
  }
  const { message_thread_id: _ignored, ...rest } = params;
  return rest;
}

export async function sendTelegramWithThreadFallback<T>(params: {
  operation: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  requestParams: Record<string, unknown>;
  send: (effectiveParams: Record<string, unknown>) => Promise<T>;
  shouldLog?: (err: unknown) => boolean;
}): Promise<T> {
  const allowThreadlessRetry = params.thread?.scope === "dm";
  const hasThreadId = hasMessageThreadIdParam(params.requestParams);
  const shouldSuppressFirstErrorLog = (err: unknown) =>
    allowThreadlessRetry && hasThreadId && isTelegramThreadNotFoundError(err);
  const mergedShouldLog = params.shouldLog
    ? (err: unknown) => params.shouldLog!(err) && !shouldSuppressFirstErrorLog(err)
    : (err: unknown) => !shouldSuppressFirstErrorLog(err);

  try {
    return await withTelegramApiErrorLogging({
      operation: params.operation,
      runtime: params.runtime,
      shouldLog: mergedShouldLog,
      fn: () => params.send(params.requestParams),
    });
  } catch (err) {
    if (!allowThreadlessRetry || !hasThreadId || !isTelegramThreadNotFoundError(err)) {
      throw err;
    }
    const retryParams = removeMessageThreadIdParam(params.requestParams);
    params.runtime.log?.(
      `telegram ${params.operation}: message thread not found; retrying without message_thread_id`,
    );
    return await withTelegramApiErrorLogging({
      operation: `${params.operation} (threadless retry)`,
      runtime: params.runtime,
      fn: () => params.send(retryParams),
    });
  }
}

export function buildTelegramSendParams(opts?: {
  replyToMessageId?: number;
  thread?: TelegramThreadSpec | null;
  silent?: boolean;
}): Record<string, unknown> {
  const threadParams = buildTelegramThreadParams(opts?.thread);
  const params: Record<string, unknown> = {};
  if (opts?.replyToMessageId) {
    params.reply_to_message_id = opts.replyToMessageId;
    params.allow_sending_without_reply = true;
  }
  if (threadParams) {
    params.message_thread_id = threadParams.message_thread_id;
  }
  if (opts?.silent === true) {
    params.disable_notification = true;
  }
  return params;
}

export async function sendTelegramText(
  bot: Bot,
  chatId: string,
  text: string,
  runtime: RuntimeEnv,
  opts?: {
    accountId?: string;
    replyToMessageId?: number;
    replyQuoteText?: string;
    thread?: TelegramThreadSpec | null;
    textMode?: "markdown" | "html";
    plainText?: string;
    linkPreview?: boolean;
    silent?: boolean;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  },
): Promise<number> {
  const textMode = opts?.textMode ?? "markdown";
  const fallbackText = opts?.plainText ?? text;
  const renderedText = textMode === "html" ? text : markdownToTelegramHtml(text);
  const hasFallbackText = fallbackText.trim().length > 0;
  const hasRenderedText = renderedText.trim().length > 0;
  if (!hasRenderedText && !hasFallbackText) {
    throw new Error("telegram sendMessage failed: empty formatted text and empty plain fallback");
  }

  const buttons =
    opts?.replyMarkup?.inline_keyboard?.map((row) =>
      row.flatMap((button) => {
        const candidate = button as {
          text?: unknown;
          callback_data?: unknown;
          style?: unknown;
        };
        if (
          typeof candidate.text !== "string" ||
          typeof candidate.callback_data !== "string"
        ) {
          return [];
        }
        return [
          {
            text: candidate.text,
            callback_data: candidate.callback_data,
            ...(typeof candidate.style === "string" ? { style: candidate.style } : {}),
          },
        ];
      }),
    )?.filter((row) => row.length > 0) as TelegramInlineButtons | undefined;

  const textToSend = hasRenderedText ? text : fallbackText;
  let result: Awaited<ReturnType<typeof sendMessageTelegram>>;
  try {
    result = await sendMessageTelegram(String(chatId), textToSend, {
      api: bot.api,
      accountId: opts?.accountId,
      verbose: false,
      textMode,
      plainText: fallbackText,
      linkPreview: opts?.linkPreview,
      silent: opts?.silent,
      messageThreadId: opts?.thread?.id,
      threadScope:
        opts?.thread?.scope === "dm" || opts?.thread?.scope === "forum"
          ? opts.thread.scope
          : undefined,
      threadlessFallback: opts?.thread == null || opts.thread.scope !== "forum",
      replyToMessageId: opts?.replyToMessageId,
      buttons,
    });
  } catch (err) {
    runtime.error?.(`telegram sendMessage failed: ${formatErrorMessage(err)}`);
    throw err;
  }
  const messageId = Number.parseInt(result.messageId, 10);
  if (!Number.isFinite(messageId)) {
    throw new Error(`telegram sendMessage returned invalid message id: ${result.messageId}`);
  }
  runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${messageId}`);
  return messageId;
}
