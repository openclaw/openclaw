import { ToolInputError } from "./tool-input-error.js";

export const DEFAULT_ASK_USER_TIMEOUT_SECONDS = 900;
export const QUESTION_RPC_GRACE_MS = 10_000;
const MIN_ASK_USER_TIMEOUT_SECONDS = 30;
const MAX_ASK_USER_TIMEOUT_SECONDS = 3600;

/** Shared human-question wait contract, including credential entry and harness watchdogs. */
export function normalizeQuestionTimeoutSeconds(rawTimeoutSeconds: unknown): number {
  if (
    rawTimeoutSeconds !== undefined &&
    (typeof rawTimeoutSeconds !== "number" ||
      !Number.isFinite(rawTimeoutSeconds) ||
      !Number.isInteger(rawTimeoutSeconds))
  ) {
    throw new ToolInputError("timeoutSeconds must be an integer");
  }
  return Math.min(
    MAX_ASK_USER_TIMEOUT_SECONDS,
    Math.max(MIN_ASK_USER_TIMEOUT_SECONDS, rawTimeoutSeconds ?? DEFAULT_ASK_USER_TIMEOUT_SECONDS),
  );
}

export function resolveQuestionTimeoutMs(rawTimeoutSeconds: unknown): number {
  return normalizeQuestionTimeoutSeconds(rawTimeoutSeconds) * 1_000 + QUESTION_RPC_GRACE_MS;
}
