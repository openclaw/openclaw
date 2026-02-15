import type { OutboundRetryConfig } from "../../../config/types.base.js";
import { retryAsync } from "../../../infra/retry.js";
import { log } from "../logger.js";

const DEFAULT_RETRY_CONFIG: OutboundRetryConfig = {
  attempts: 10,
  minDelayMs: 1000,
  maxDelayMs: 60000,
  jitter: 0.2,
};

function isRetryableError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return /tpm|rate_limit|429|too many requests|quota exceeded|resource exhausted/i.test(msg);
}

function getRetryAfterMs(err: unknown): number | undefined {
  const match = String(err).match(/retry_after[:\s]*(\d+)/i);
  if (match) {
    return Number(match[1]) * 1000;
  }
  return undefined;
}

export function getRetryConfig(
  provider: string,
  config?: { models?: { providers?: Record<string, { retry?: OutboundRetryConfig }> } },
): OutboundRetryConfig | undefined {
  return config?.models?.providers?.[provider]?.retry;
}

export async function runWithPromptRetry<T>(
  fn: () => Promise<T>,
  provider: string,
  modelId: string,
  retryConfig?: OutboundRetryConfig,
): Promise<T> {
  // First check for config-based retry, fall back to default
  const effectiveConfig = retryConfig ?? DEFAULT_RETRY_CONFIG;

  const attempts = effectiveConfig.attempts ?? DEFAULT_RETRY_CONFIG.attempts!;
  const minDelayMs = effectiveConfig.minDelayMs ?? DEFAULT_RETRY_CONFIG.minDelayMs!;
  const maxDelayMs = effectiveConfig.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs!;
  const jitter = effectiveConfig.jitter ?? DEFAULT_RETRY_CONFIG.jitter!;

  return retryAsync(fn, {
    attempts,
    minDelayMs,
    maxDelayMs,
    jitter,
    shouldRetry: isRetryableError,
    retryAfterMs: getRetryAfterMs,
    onRetry: (info) => {
      log.warn(
        `[prompt-retry] provider=${provider} model=${modelId} ` +
          `attempt=${info.attempt}/${info.maxAttempts} delay=${info.delayMs}ms`,
      );
    },
  });
}

export type { OutboundRetryConfig };
