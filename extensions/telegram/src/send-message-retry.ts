import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRetryableSendMessageError } from "./network-errors.js";

const SEND_MESSAGE_BACKOFF_MS: readonly [number, number, number] = [500, 2000, 8000];
const SEND_MESSAGE_JITTER = 0.25;

export type SendMessageRetryLogger = (message: string) => void;

export type SendMessageRetryOptions = {
  /** Injected for deterministic tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for deterministic tests. Defaults to Math.random. */
  random?: () => number;
  /** Injected for deterministic tests. Defaults to the shared retry predicate. */
  isRetryable?: (err: unknown) => boolean;
  /** Optional diagnostic-level logger. */
  log?: SendMessageRetryLogger;
  /** Label used in retry log lines. Defaults to "sendMessage". */
  label?: string;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const applyJitter = (baseMs: number, random: () => number) => {
  const delta = baseMs * SEND_MESSAGE_JITTER * (random() * 2 - 1);
  return Math.max(0, Math.round(baseMs + delta));
};

/**
 * Wrap a Telegram sendMessage call with a bounded retry on transient network
 * errors. Up to three retries with 500ms → 2s → 8s backoff (±25% jitter).
 * Only retries errors that match `isRetryableSendMessageError` — permanent
 * 4xx rejections (400/403/429) short-circuit immediately.
 */
export async function withSendMessageRetry<T>(
  fn: () => Promise<T>,
  options: SendMessageRetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const isRetryable = options.isRetryable ?? isRetryableSendMessageError;
  const label = options.label ?? "sendMessage";
  let lastError: unknown;
  for (let attempt = 0; attempt <= SEND_MESSAGE_BACKOFF_MS.length; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === SEND_MESSAGE_BACKOFF_MS.length || !isRetryable(err)) {
        throw err;
      }
      const baseMs = SEND_MESSAGE_BACKOFF_MS[attempt] ?? 0;
      const delayMs = applyJitter(baseMs, random);
      options.log?.(
        `telegram ${label} retry ${attempt + 1}/${SEND_MESSAGE_BACKOFF_MS.length} in ${delayMs}ms: ${formatErrorMessage(err)}`,
      );
      await sleep(delayMs);
    }
  }
  // Unreachable: the loop either returns a value or throws. Narrow for the type
  // checker and preserve the latest error context if reached.
  throw lastError;
}

export const SEND_MESSAGE_RETRY_BACKOFF_MS: readonly [number, number, number] =
  SEND_MESSAGE_BACKOFF_MS;
