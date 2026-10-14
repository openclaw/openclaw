import { retryAsync } from "@openclaw/retry";

// Retry helper for transient filesystem reads observed on memory stores.

const TRANSIENT_MEMORY_READ_ERRNO = -11;
const TRANSIENT_MEMORY_READ_CODES = new Set(["EAGAIN", "EWOULDBLOCK", "EDEADLK"]);
const TRANSIENT_MEMORY_READ_MESSAGE = /Unknown system error -11\b/i;

/** Retry a memory read with the narrow transient error predicate. */
export async function retryTransientMemoryRead<T>(
  read: () => Promise<T>,
  label = "memory read",
): Promise<T> {
  return await retryAsync(read, {
    attempts: 3,
    minDelayMs: 25,
    maxDelayMs: 50,
    label,
    shouldRetry: (error) => {
      const details = error as { code?: unknown; errno?: unknown } | null | undefined;
      const code = details?.code;
      return (
        (typeof code === "string" && TRANSIENT_MEMORY_READ_CODES.has(code)) ||
        details?.errno === TRANSIENT_MEMORY_READ_ERRNO ||
        (error instanceof Error && TRANSIENT_MEMORY_READ_MESSAGE.test(error.message))
      );
    },
  });
}
