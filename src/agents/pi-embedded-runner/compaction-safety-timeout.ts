export const EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000;
export const EMBEDDED_COMPACTION_RETRY_TIMEOUT_MS = 120_000; // 2 min retry after timeout

export class CompactionSafetyTimeoutError extends Error {
  readonly isCompactionTimeout = true;
  constructor(timeoutMs: number) {
    super(`Compaction timed out after ${timeoutMs}ms`);
    this.name = "CompactionSafetyTimeoutError";
  }
}

/**
 * Races `compact()` against a deadline. If the deadline fires first,
 * rejects with `CompactionSafetyTimeoutError`. If the work throws first,
 * that original error propagates unchanged so callers can distinguish
 * provider/validation failures from actual timeouts.
 */
export async function compactWithSafetyTimeout<T>(
  compact: () => Promise<T>,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new CompactionSafetyTimeoutError(timeoutMs));
    }, timeoutMs);
    timerId.unref?.();
  });
  try {
    return await Promise.race([compact(), timeoutPromise]);
  } finally {
    clearTimeout(timerId);
  }
}
