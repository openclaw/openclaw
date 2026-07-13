// Line plugin module implements outbound delivery error tagging.

/**
 * Tag a delivery error as a visible partial delivery. When content already reached the
 * user before the failure, the core (`src/auto-reply/dispatch.ts`) reads
 * `sentBeforeError` / `visibleReplySent` to suppress a duplicate fallback delivery.
 */
export function markLineVisibleDeliveryError(error: unknown): Error {
  if (error instanceof Error && Object.isExtensible(error)) {
    Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
    return error;
  }
  const visibleError = new Error("LINE message delivery failed", { cause: error });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}
