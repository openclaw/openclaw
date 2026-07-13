export type TelegramDeferredAdmissionCallback = (
  admitted: boolean,
  cacheMessage?: boolean,
) => Promise<boolean>;

export function combineTelegramDeferredAdmissionCallbacks(
  callbacks: TelegramDeferredAdmissionCallback[],
  primaryCallback = callbacks.at(-1),
  canSuppressCombinedTurn = true,
): TelegramDeferredAdmissionCallback | undefined {
  if (callbacks.length === 0) {
    return undefined;
  }
  const invokeCallback = (
    callback: TelegramDeferredAdmissionCallback,
    admitted: boolean,
    cacheMessage: boolean,
  ) => (cacheMessage ? callback(admitted) : callback(admitted, false));
  return async (admitted: boolean, cacheMessage = true) => {
    if (admitted && canSuppressCombinedTurn) {
      if (primaryCallback && (await invokeCallback(primaryCallback, true, cacheMessage))) {
        // Suppressed combined turns release sibling reservations without leaking
        // their source messages into later prompt context.
        await Promise.all(
          callbacks
            .filter((callback) => callback !== primaryCallback)
            .map((callback) => callback(false, false)),
        );
        return true;
      }
      await Promise.all(
        callbacks
          .filter((callback) => callback !== primaryCallback)
          .map((callback) => invokeCallback(callback, false, cacheMessage)),
      );
      return false;
    }
    await Promise.all(callbacks.map((callback) => invokeCallback(callback, false, cacheMessage)));
    return false;
  };
}
