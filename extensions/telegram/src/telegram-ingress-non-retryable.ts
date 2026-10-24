import {
  collectErrorGraphCandidates,
  formatErrorMessage,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { TelegramMessageDispatchReplayForgetError } from "./message-dispatch-dedupe.js";
import { TelegramIngressPayloadError } from "./telegram-ingress-spool.payload.js";

const MISSING_AGENT_HARNESS_ERROR_NAME = "MissingAgentHarnessError";
const MISSING_AGENT_HARNESS_MESSAGE_RE = /Requested agent harness "[^"]+" is not registered\./u;
// Only rejected recipients are permanent: other Telegram 403s can recover
// after chat permissions change and must remain eligible for retry.
const TELEGRAM_UNREACHABLE_RECIPIENT_RE =
  /\b403\b[\s\S]*\b(?:bot was blocked by the user|bot was kicked|user is deactivated)\b/iu;

/** Keeps callback-only terminal failures out of ordinary message retry policy. */
export class TelegramCallbackProcessingError extends Error {
  constructor(cause: unknown) {
    super(String(cause), { cause });
    this.name = "TelegramCallbackProcessingError";
  }
}

type TelegramIngressNonRetryableFailure = {
  reason:
    | "invalid-event"
    | "missing-agent-harness"
    | "dispatch-dedupe-rollback-failed"
    | "session-archived"
    | "recipient-unreachable"
    | "callback-authority-changed"
    | "callback-query-expired";
  message: string;
};

/** Channel-owned non-retryable predicate for the core ingress drain. */
export function resolveTelegramIngressNonRetryableFailure(
  err: unknown,
): TelegramIngressNonRetryableFailure | null {
  const candidates = collectErrorGraphCandidates(err, (current) => [current.cause, current.error]);
  const callbackFailure = candidates.some(
    (candidate) => candidate instanceof TelegramCallbackProcessingError,
  );
  for (const candidate of candidates) {
    const message = formatErrorMessage(candidate);
    if (callbackFailure && candidate instanceof Error) {
      if (candidate.message === "Gateway requester authority changed") {
        return { reason: "callback-authority-changed", message };
      }
      if (
        isRecord(candidate) &&
        candidate.error_code === 400 &&
        candidate.method === "answerCallbackQuery" &&
        typeof candidate.description === "string" &&
        /query is too old|query ID is invalid/iu.test(candidate.description)
      ) {
        return { reason: "callback-query-expired", message };
      }
    }
    if (candidate instanceof TelegramIngressPayloadError) {
      return { reason: "invalid-event", message };
    }
    if (candidate instanceof TelegramMessageDispatchReplayForgetError) {
      // A committed dispatch key that cannot be rolled back makes retry unsafe:
      // the next replay can be duplicate-suppressed and then deleted.
      return { reason: "dispatch-dedupe-rollback-failed", message };
    }
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "reason" in candidate &&
      "retryable" in candidate &&
      readErrorName(candidate) === "SessionWorkStartError" &&
      candidate.reason === "archived" &&
      candidate.retryable === false
    ) {
      return { reason: "session-archived", message };
    }
    if (TELEGRAM_UNREACHABLE_RECIPIENT_RE.test(message)) {
      return { reason: "recipient-unreachable", message };
    }
    if (
      readErrorName(candidate) === MISSING_AGENT_HARNESS_ERROR_NAME ||
      MISSING_AGENT_HARNESS_MESSAGE_RE.test(message)
    ) {
      return { reason: "missing-agent-harness", message };
    }
  }
  return null;
}
