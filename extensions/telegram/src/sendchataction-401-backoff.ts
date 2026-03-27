import type { Bot } from "grammy";
import {
  computeBackoff,
  sleepWithAbort,
  type BackoffPolicy,
} from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  isRecoverableTelegramNetworkError,
  isTelegramRateLimitError,
  isTelegramServerError,
} from "./network-errors.js";

export type TelegramSendChatActionLogger = (message: string) => void;

type ChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "find_location"
  | "record_video_note"
  | "upload_video_note"
  | "choose_sticker";

type TelegramSendChatActionParams = Parameters<Bot["api"]["sendChatAction"]>[2];

type SendChatActionFn = (
  chatId: number | string,
  action: ChatAction,
  threadParams?: TelegramSendChatActionParams,
) => Promise<true>;

export type TelegramSendChatActionHandler = {
  /**
   * Send a chat action with automatic 401 backoff and circuit breaker.
   * Safe to call from multiple concurrent message contexts.
   */
  sendChatAction: (
    chatId: number | string,
    action: ChatAction,
    threadParams?: TelegramSendChatActionParams,
  ) => Promise<void>;
  isSuspended: () => boolean;
  reset: () => void;
};

export type CreateTelegramSendChatActionHandlerParams = {
  sendChatActionFn: SendChatActionFn;
  logger: TelegramSendChatActionLogger;
  maxConsecutive401?: number;
  runtime?: Partial<{
    computeBackoff: typeof computeBackoff;
    sleepWithAbort: typeof sleepWithAbort;
  }>;
};

const BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 1000,
  maxMs: 300_000, // 5 minutes
  factor: 2,
  jitter: 0.1,
};

const TRANSIENT_COOLDOWN_POLICY: BackoffPolicy = {
  initialMs: 3000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.1,
};

function is401Error(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return (
    message.includes("401") || normalizeLowercaseStringOrEmpty(message).includes("unauthorized")
  );
}

function isTransientSendChatActionError(error: unknown): boolean {
  return (
    isTelegramRateLimitError(error) ||
    isRecoverableTelegramNetworkError(error, { context: "unknown", allowMessageMatch: true }) ||
    isTelegramServerError(error)
  );
}

/**
 * Creates a GLOBAL (per-account) handler for sendChatAction that tracks 401 errors
 * across all message contexts. This prevents the infinite loop that caused Telegram
 * to delete bots (issue #27092).
 *
 * When a 401 occurs, exponential backoff is applied (1s → 2s → 4s → ... → 5min).
 * After maxConsecutive401 failures (default 10), all sendChatAction calls are
 * suspended until reset() is called.
 */
export function createTelegramSendChatActionHandler({
  sendChatActionFn,
  logger,
  maxConsecutive401 = 10,
  runtime,
}: CreateTelegramSendChatActionHandlerParams): TelegramSendChatActionHandler {
  const computeBackoffFn = runtime?.computeBackoff ?? computeBackoff;
  const sleepWithAbortFn = runtime?.sleepWithAbort ?? sleepWithAbort;
  let consecutive401Failures = 0;
  let consecutiveTransientFailures = 0;
  let transientCooldownUntil = 0;
  let lastTransientError: unknown;
  let suspended = false;

  const reset = () => {
    consecutive401Failures = 0;
    consecutiveTransientFailures = 0;
    transientCooldownUntil = 0;
    lastTransientError = undefined;
    suspended = false;
  };

  const sendChatAction = async (
    chatId: number | string,
    action: ChatAction,
    threadParams?: TelegramSendChatActionParams,
  ): Promise<void> => {
    if (suspended) {
      return;
    }

    if (transientCooldownUntil > Date.now()) {
      throw lastTransientError;
    }

    if (consecutive401Failures > 0) {
      const backoffMs = computeBackoffFn(BACKOFF_POLICY, consecutive401Failures);
      logger(
        `sendChatAction backoff: waiting ${backoffMs}ms before retry ` +
          `(failure ${consecutive401Failures}/${maxConsecutive401})`,
      );
      await sleepWithAbortFn(backoffMs);
    }

    try {
      await sendChatActionFn(chatId, action, threadParams);
      // Success: reset failure counter
      if (consecutive401Failures > 0) {
        logger(`sendChatAction recovered after ${consecutive401Failures} consecutive 401 failures`);
        consecutive401Failures = 0;
      }
      if (consecutiveTransientFailures > 0) {
        logger(
          `sendChatAction recovered after ${consecutiveTransientFailures} consecutive transient failures`,
        );
        consecutiveTransientFailures = 0;
        transientCooldownUntil = 0;
        lastTransientError = undefined;
      }
    } catch (error) {
      if (is401Error(error)) {
        consecutiveTransientFailures = 0;
        transientCooldownUntil = 0;
        lastTransientError = undefined;
        consecutive401Failures++;

        if (consecutive401Failures >= maxConsecutive401) {
          suspended = true;
          logger(
            `CRITICAL: sendChatAction suspended after ${consecutive401Failures} consecutive 401 errors. ` +
              `Bot token is likely invalid. Telegram may DELETE the bot if requests continue. ` +
              `Replace the token and restart: openclaw channels restart telegram`,
          );
        } else {
          logger(
            `sendChatAction 401 error (${consecutive401Failures}/${maxConsecutive401}). ` +
              `Retrying with exponential backoff.`,
          );
        }
      } else if (isTransientSendChatActionError(error)) {
        consecutiveTransientFailures++;
        transientCooldownUntil =
          Date.now() + computeBackoffFn(TRANSIENT_COOLDOWN_POLICY, consecutiveTransientFailures);
        lastTransientError = error;
        // Typing indicators are best-effort. Once we enter cooldown, skip repeated
        // sendChatAction calls, but keep rejecting so the typing start guard can
        // count failures and trip its circuit breaker during outages or rate limits.
        logger(
          `sendChatAction transient failure (${consecutiveTransientFailures}). ` +
            `Cooling down before the next retry.`,
        );
      }
      throw error;
    }
  };

  return {
    sendChatAction,
    isSuspended: () => suspended,
    reset,
  };
}
