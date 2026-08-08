import type { RealtimeVoiceCloseReason } from "openclaw/plugin-sdk/realtime-voice";

export type RealtimeDeferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  settled: boolean;
};

export function createCompletion(): {
  promise: Promise<RealtimeVoiceCloseReason>;
  resolve: (reason: RealtimeVoiceCloseReason) => void;
} {
  let resolve!: (reason: RealtimeVoiceCloseReason) => void;
  const promise = new Promise<RealtimeVoiceCloseReason>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function createDeferred(): RealtimeDeferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const deferred: RealtimeDeferred = {
    promise: new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: () => {
      if (!deferred.settled) {
        deferred.settled = true;
        resolvePromise();
      }
    },
    reject: (error) => {
      if (!deferred.settled) {
        deferred.settled = true;
        rejectPromise(error);
      }
    },
    settled: false,
  };
  void deferred.promise.catch(() => undefined);
  return deferred;
}
