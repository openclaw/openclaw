import { withTimeout } from "../../node-host/with-timeout.js";

export const EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000;
export const EMBEDDED_COMPACTION_RETRY_TIMEOUT_MS = 120_000; // 2 min retry after timeout

export class CompactionSafetyTimeoutError extends Error {
  readonly isCompactionTimeout = true;
  constructor(timeoutMs: number) {
    super(`Compaction timed out after ${timeoutMs}ms`);
    this.name = "CompactionSafetyTimeoutError";
  }
}

export async function compactWithSafetyTimeout<T>(
  compact: () => Promise<T>,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
): Promise<T> {
  try {
    return await withTimeout(() => compact(), timeoutMs, "Compaction");
  } catch {
    throw new CompactionSafetyTimeoutError(timeoutMs);
  }
}
