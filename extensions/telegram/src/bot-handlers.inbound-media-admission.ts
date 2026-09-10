import type { BufferedMediaGroupEntry } from "./bot-handlers.inbound-media.types.js";

function createTelegramMediaGroupDispatchAdmission(params: {
  entry: BufferedMediaGroupEntry;
  hasPendingAuthorization: () => boolean;
}) {
  const attemptController = new AbortController();
  let pausedForPendingAuthorization = false;
  return {
    admission: {
      abortSignal: AbortSignal.any([
        params.entry.dispatchAbortController.signal,
        attemptController.signal,
      ]),
      tryAdmit: () => {
        if (params.hasPendingAuthorization()) {
          pausedForPendingAuthorization = true;
          attemptController.abort("skipped");
          return false;
        }
        if (params.entry.dispatchAdmission === "pending") {
          params.entry.dispatchAdmission = "admitted";
        }
        return params.entry.dispatchAdmission === "admitted";
      },
    },
    wasPausedForPendingAuthorization: () => pausedForPendingAuthorization,
  };
}

export async function runTelegramMediaGroupDispatchAttempts<T>(params: {
  entry: BufferedMediaGroupEntry;
  hasPendingAuthorization: () => boolean;
  waitForPendingAuthorization: () => Promise<void>;
  stopCancelledEntry: () => Promise<boolean>;
  dispatch: (admission: { abortSignal: AbortSignal; tryAdmit: () => boolean }) => Promise<T>;
}): Promise<T | undefined> {
  while (true) {
    const attempt = createTelegramMediaGroupDispatchAdmission(params);
    const result = await params.dispatch(attempt.admission);
    if (!attempt.wasPausedForPendingAuthorization()) {
      return result;
    }
    await params.waitForPendingAuthorization();
    if (await params.stopCancelledEntry()) {
      return undefined;
    }
  }
}
