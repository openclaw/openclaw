/**
 * Timeout control utility module
 *
 * Provides a unified timeout protection mechanism for async operations
 */

/**
 * Adds timeout protection to a Promise
 *
 * @param promise - The original Promise
 * @param timeoutMs - Timeout duration (milliseconds)
 * @param message - Timeout error message
 * @returns A Promise with timeout protection
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message?: string,
): Promise<T> {
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return promise;
  }

  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(message ?? `Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

/**
 * Timeout error type
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
