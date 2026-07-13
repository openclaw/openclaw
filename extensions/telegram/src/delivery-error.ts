// Telegram plugin module implements partial delivery error metadata.
export function markTelegramDeliveryErrorVisible(error: unknown): unknown {
  if (typeof error === "object" && error !== null && Object.isExtensible(error)) {
    Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
    return error;
  }
  const visibleError = new Error("visible Telegram delivery failed", { cause: error });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}

export function isTelegramDeliveryErrorVisible(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("sentBeforeError" in error && error.sentBeforeError === true) ||
      ("visibleReplySent" in error && error.visibleReplySent === true))
  );
}
