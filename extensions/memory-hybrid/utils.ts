/**
 * Shared Utilities Module
 *
 * Common helpers used across multiple modules to avoid duplication.
 */

/**
 * Retry with exponential backoff for API calls.
 * Handles 429 (rate limit), 503 (overloaded), and RESOURCE_EXHAUSTED errors.
 *
 * @param fn - Async function to retry
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param baseDelay - Base delay in ms before first retry (default: 1000)
 * @returns Result of the function call
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const msg = lastError.message;
      const isRetryable =
        msg.includes("429") ||
        msg.includes("503") ||
        msg.includes("rate") ||
        msg.includes("overloaded") ||
        msg.includes("RESOURCE_EXHAUSTED");

      if (!isRetryable || attempt === maxRetries) {
        throw lastError;
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}
