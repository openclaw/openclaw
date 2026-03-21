import {
  collectErrorGraphCandidates,
  computeBackoff,
  sleepWithAbort,
  type BackoffPolicy,
} from "openclaw/plugin-sdk/infra-runtime";
import { isRecoverableTelegramNetworkError, isTelegramClientRejection } from "./network-errors.js";

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

type SendChatActionFn = (
  chatId: number | string,
  action: ChatAction,
  threadParams?: unknown,
) => Promise<unknown>;

export type TelegramSendChatActionHandler = {
  /**
   * Send a chat action with automatic 401 backoff and circuit breaker.
   * Safe to call from multiple concurrent message contexts.
   */
  sendChatAction: (
    chatId: number | string,
    action: ChatAction,
    threadParams?: unknown,
  ) => Promise<void>;
  isSuspended: () => boolean;
  noteNetworkHealthy: () => void;
  reset: () => void;
};

export type CreateTelegramSendChatActionHandlerParams = {
  sendChatActionFn: SendChatActionFn;
  logger: TelegramSendChatActionLogger;
  maxConsecutive401?: number;
  maxConsecutiveNetworkFailures?: number;
  onRecoverableNetworkFailure?: (params: {
    error: unknown;
    consecutiveFailures: number;
  }) => void | Promise<void>;
};

const BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 1000,
  maxMs: 300_000, // 5 minutes
  factor: 2,
  jitter: 0.1,
};

function collectTelegramErrorCandidates(err: unknown) {
  return collectErrorGraphCandidates(err, (current) => {
    const nested: Array<unknown> = [current.cause, current.reason];
    if (Array.isArray(current.errors)) {
      nested.push(...current.errors);
    }
    if ("error" in current) {
      nested.push(current.error);
    }
    return nested;
  });
}

function hasTelegramErrorCode(err: unknown, expectedCode: number): boolean {
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if (!("error_code" in candidate)) {
      continue;
    }
    const code = (candidate as { error_code?: unknown }).error_code;
    if (typeof code === "number" && code === expectedCode) {
      return true;
    }
  }
  return false;
}

function isTelegramUnauthorizedError(error: unknown): boolean {
  return hasTelegramErrorCode(error, 401);
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
  maxConsecutiveNetworkFailures = 2,
  onRecoverableNetworkFailure,
}: CreateTelegramSendChatActionHandlerParams): TelegramSendChatActionHandler {
  let consecutive401Failures = 0;
  let consecutiveNetworkFailures = 0;
  let networkFailureSignaled = false;
  let suspended = false;

  const noteNetworkHealthy = () => {
    consecutiveNetworkFailures = 0;
    networkFailureSignaled = false;
  };

  const reset = () => {
    consecutive401Failures = 0;
    noteNetworkHealthy();
    suspended = false;
  };

  const sendChatAction = async (
    chatId: number | string,
    action: ChatAction,
    threadParams?: unknown,
  ): Promise<void> => {
    if (suspended) {
      return;
    }

    if (consecutive401Failures > 0) {
      const backoffMs = computeBackoff(BACKOFF_POLICY, consecutive401Failures);
      logger(
        `sendChatAction backoff: waiting ${backoffMs}ms before retry ` +
          `(failure ${consecutive401Failures}/${maxConsecutive401})`,
      );
      await sleepWithAbort(backoffMs);
    }

    try {
      await sendChatActionFn(chatId, action, threadParams);
      // Success: reset failure counter
      if (consecutive401Failures > 0) {
        logger(`sendChatAction recovered after ${consecutive401Failures} consecutive 401 failures`);
        consecutive401Failures = 0;
      }
      noteNetworkHealthy();
    } catch (error) {
      if (isTelegramUnauthorizedError(error)) {
        consecutive401Failures++;
        // 401 means the request reached Telegram, so the network is healthy.
        noteNetworkHealthy();

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
      } else if (isRecoverableTelegramNetworkError(error, { context: "unknown" })) {
        consecutiveNetworkFailures++;
        if (
          onRecoverableNetworkFailure &&
          !networkFailureSignaled &&
          consecutiveNetworkFailures >= maxConsecutiveNetworkFailures
        ) {
          networkFailureSignaled = true;
          void onRecoverableNetworkFailure({
            error,
            consecutiveFailures: consecutiveNetworkFailures,
          });
        }
      } else if (isTelegramClientRejection(error)) {
        // Any non-network Telegram response (429, 403, etc.) proves the request
        // reached Telegram, so the network is healthy — break the outage streak.
        noteNetworkHealthy();
      }
      throw error;
    }
  };

  return {
    sendChatAction,
    isSuspended: () => suspended,
    noteNetworkHealthy,
    reset,
  };
}
