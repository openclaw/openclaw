import { withTimeout } from "../../node-host/with-timeout.js";

export const EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000;

export async function compactWithSafetyTimeout<T>(
  compact: () => Promise<T>,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
): Promise<T> {
  return await withTimeout(() => compact(), timeoutMs, "Compaction");
}
