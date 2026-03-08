import type { OutboundRetryConfig } from "../../../config/types.base.js";
import { sleepWithAbort } from "../../../infra/backoff.js";
import { log } from "../logger.js";

// Rate limit detection regex - matches TPM/rate limit errors specifically
// SDK's _isRetryableError covers more cases (500, 502, connection errors) but
// we only want to retry rate limits externally as a TPM fallback.
const RATE_LIMIT_RE =
  /rate.?limit|too many requests|throttl|429|tpm|tokens.?per.?minute|quota.?exceeded|resource.?exhausted|overloaded/i;

/**
 * Check if an error message indicates a rate limit / TPM error.
 */
function isRateLimitErrorMessage(msg: string): boolean {
  return RATE_LIMIT_RE.test(msg);
}

function applyJitter(delayMs: number, jitter: number): number {
  if (jitter <= 0 || !jitter) {
    return delayMs;
  }
  const offset = (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(delayMs * (1 + offset)));
}

function resolveDelay(config: OutboundRetryConfig, attempt: number): number {
  const minDelay = config.minDelayMs ?? 5000;
  const maxDelay = config.maxDelayMs ?? 60000;
  const jitter = config.jitter ?? 0;

  // Use exponential backoff: minDelay, minDelay*2, minDelay*4, ...
  const baseDelay = minDelay * Math.pow(2, attempt - 1);
  const delay = applyJitter(baseDelay, jitter);
  // Clamp to maxDelay
  return Math.min(delay, maxDelay);
}

export function getRetryConfig(
  provider: string,
  config?: { models?: { providers?: Record<string, { retry?: OutboundRetryConfig }> } },
): OutboundRetryConfig | undefined {
  return config?.models?.providers?.[provider]?.retry;
}

/**
 * Default rate limit recovery config (conservative settings suitable for TPM limits).
 * - 5 attempts with exponential backoff starting at 5s
 * - 30% jitter to prevent thundering herd on recovery
 */
const DEFAULT_RECOVERY_CONFIG: OutboundRetryConfig = {
  attempts: 5,
  minDelayMs: 5000,
  maxDelayMs: 60000,
  jitter: 0.3,
};

/**
 * Tracks individual retry attempts for diagnostics.
 */
interface RetryAttempt {
  attempt: number;
  delayMs: number;
  errorMessage: string;
}

/**
 * Minimal interface for SDK session object we need to access.
 * We only access messages and agent properties for rate limit detection.
 */
interface SdkSessionLike {
  messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string }>;
  agent?: {
    replaceMessages: (messages: unknown[]) => void;
  };
}

function isSdkSessionLike(value: unknown): value is SdkSessionLike {
  return typeof value === "object" && value !== null && ("messages" in value || "agent" in value);
}

export async function runWithPromptRetry<T>(
  fn: () => Promise<T>,
  retryConfig?: OutboundRetryConfig,
  signal?: AbortSignal,
  session?: unknown,
): Promise<T> {
  const config = retryConfig ?? DEFAULT_RECOVERY_CONFIG;
  const attempts = config.attempts ?? 5;
  const retryHistory: RetryAttempt[] = [];
  let lastError: unknown;
  let lastErrorMessage = "";

  // Track removed error messages for potential restoration on final failure
  // This ensures non-invasive behavior: if all retries fail, the original
  // error message is restored so users see the same result as without retry.
  type AssistantMessage = { role?: string; stopReason?: string; errorMessage?: string };
  const removedErrorMessages: AssistantMessage[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn();

      // Check for SDK-internal errors that were converted to assistant messages
      // (SDK catches LLM errors and creates error assistant messages instead of throwing)
      if (isSdkSessionLike(session)) {
        const messages = session.messages;

        // Find last assistant message
        let lastAssistant: AssistantMessage | undefined;
        if (messages && Array.isArray(messages)) {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.role === "assistant") {
              lastAssistant = messages[i];
              break;
            }
          }
        }

        // Check if it's an error message that indicates rate limit
        if (
          lastAssistant &&
          lastAssistant.stopReason === "error" &&
          lastAssistant.errorMessage &&
          isRateLimitErrorMessage(lastAssistant.errorMessage)
        ) {
          const errorMsg = lastAssistant.errorMessage;
          log.warn(`[rate-limit] SDK error detected: ${errorMsg.slice(0, 200)}`);

          // Save the error message for potential restoration
          removedErrorMessages.push(lastAssistant);

          // Remove the error assistant message using replaceMessages (immutable pattern)
          const agent = session.agent;
          if (agent && typeof agent.replaceMessages === "function" && messages) {
            const filtered = messages.filter((m) => m !== lastAssistant);
            agent.replaceMessages(filtered);
          }

          // Throw to trigger retry
          throw new Error(`Rate limit error: ${errorMsg}`);
        }
      }

      return result;
    } catch (err) {
      lastError = err;

      // Extract error message
      if (err instanceof Error) {
        lastErrorMessage = err.message;
      } else if (typeof err === "string") {
        lastErrorMessage = err;
      } else if (typeof err === "object" && err !== null) {
        const msgProp = (err as Record<string, unknown>).message;
        lastErrorMessage = typeof msgProp === "string" ? msgProp : "(object error)";
      } else {
        lastErrorMessage = String(err);
      }

      // Check if it's a rate limit error
      // We only retry rate limit / TPM errors, not all errors
      if (!isRateLimitErrorMessage(lastErrorMessage)) {
        log.debug(
          `[rate-limit] Non-rate-limit error, not retrying: ${lastErrorMessage.slice(0, 100)}`,
        );
        // Restore removed error messages before throwing
        if (isSdkSessionLike(session) && removedErrorMessages.length > 0) {
          const agent = session.agent;
          const messages = session.messages;
          if (agent && typeof agent.replaceMessages === "function" && messages) {
            agent.replaceMessages([...messages, ...removedErrorMessages]);
          }
        }
        throw err;
      }

      // Rate limit error - wait and retry
      if (attempt >= attempts) {
        log.warn(`[rate-limit] Exhausted ${attempts} attempts, last error: ${lastErrorMessage}`);

        // Restore removed error messages to maintain non-invasive behavior
        // Users will see the same error message as without retry logic
        if (isSdkSessionLike(session) && removedErrorMessages.length > 0) {
          const agent = session.agent;
          const messages = session.messages;
          if (agent && typeof agent.replaceMessages === "function" && messages) {
            const restored = [...messages, ...removedErrorMessages];
            agent.replaceMessages(restored);
            log.debug(`[rate-limit] Restored ${removedErrorMessages.length} error message(s)`);
          }
        }

        throw err;
      }

      const delay = resolveDelay(config, attempt);

      retryHistory.push({
        attempt,
        delayMs: delay,
        errorMessage: lastErrorMessage,
      });

      log.info(
        `[rate-limit] Retry attempt ${attempt}/${attempts} after ${delay}ms, ` +
          `reason: ${lastErrorMessage.slice(0, 100)}`,
      );

      await sleepWithAbort(delay, signal);
    }
  }

  // Should not reach here, but TypeScript needs this
  throw lastError;
}

export type { OutboundRetryConfig };
