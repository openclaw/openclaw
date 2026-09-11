import { createDeferred } from "openclaw/plugin-sdk/extension-shared";

type PersistenceReceipt = ReturnType<typeof createDeferred<void>>;

export function createTranscriptReceiptRegistry(getFailure: () => Error | undefined) {
  const receipts = new Map<string, PersistenceReceipt>();
  return {
    get: (eventId: string) => {
      let receipt = receipts.get(eventId);
      if (!receipt) {
        receipt = createDeferred<void>();
        void receipt.promise.catch(() => undefined);
        receipts.set(eventId, receipt);
        const failure = getFailure();
        if (failure) {
          receipt.reject(failure);
        }
      }
      return receipt;
    },
    rejectAll(error: Error) {
      for (const receipt of receipts.values()) {
        receipt.reject(error);
      }
    },
  };
}

export async function drainScheduledJournalQueue(
  getQueue: () => Promise<void>,
  onDrained?: () => void,
): Promise<void> {
  while (true) {
    const tail = getQueue();
    await tail;
    if (tail === getQueue()) {
      onDrained?.();
      return;
    }
  }
}

export function createProviderTerminalJournalLifecycle<
  TWrite extends { eventId?: string },
  TResult,
>(params: {
  abandonPendingTools: () => void;
  accept: (result: TResult) => boolean;
  append: (write: TWrite) => Promise<TResult | undefined>;
  drainQueue: (onDrained?: () => void) => Promise<void>;
  markReplayInvalid: () => void;
  publish: (appended: boolean) => Promise<void>;
  receiptForEvent: (eventId: string) => PersistenceReceipt;
  rejectUnsettledEvent: (eventId: string, error: Error) => void;
}) {
  const acceptedEventIds = new Set<string>();
  const deferredWrites: TWrite[] = [];
  let phase: "active" | "finalizing" | "finalized" = "active";
  let finalization: Promise<void> | undefined;
  const rejectSdkUserEvent = (eventId: string, error: unknown) => {
    params.rejectUnsettledEvent(eventId, error instanceof Error ? error : new Error(String(error)));
  };
  const rejectTerminalSdkUserEvent = (eventId: string) => {
    rejectSdkUserEvent(
      eventId,
      new Error("Copilot steering ended before its SDK user event could persist"),
    );
  };

  const flushDeferred = async (preserveProviderError = false) => {
    let appended = false;
    const persistedReceipts: PersistenceReceipt[] = [];
    for (const write of deferredWrites.splice(0)) {
      try {
        const outcome = await params.append(write);
        if (!outcome) {
          params.markReplayInvalid();
          if (write.eventId) {
            params
              .receiptForEvent(write.eventId)
              .reject(new Error("Copilot steering user write was suppressed"));
          }
          continue;
        }
        appended = params.accept(outcome) || appended;
        if (write.eventId) {
          persistedReceipts.push(params.receiptForEvent(write.eventId));
        }
      } catch (error) {
        if (!preserveProviderError) {
          throw error;
        }
        params.markReplayInvalid();
        if (write.eventId) {
          params.receiptForEvent(write.eventId).reject(error);
        }
      }
    }
    return { appended, persistedReceipts };
  };

  return {
    acceptSdkUserEvent(eventId: string) {
      acceptedEventIds.add(eventId);
      void params.receiptForEvent(eventId).promise.then(
        () => acceptedEventIds.delete(eventId),
        () => acceptedEventIds.delete(eventId),
      );
    },
    assertAccepting() {
      if (phase !== "active") {
        throw new Error("Copilot steering is unavailable after provider termination");
      }
    },
    defer(write: TWrite) {
      if (phase === "finalized") {
        throw new Error("Copilot steering cannot defer after provider termination");
      }
      deferredWrites.push(write);
    },
    flushDeferred,
    get phase() {
      return phase;
    },
    rejectSdkUserEvent,
    rejectTerminalSdkUserEvent,
    finalize: async () => {
      if (finalization) {
        return await finalization;
      }
      // Admission closes synchronously; sends already in flight register before
      // the queue drains, so every accepted receipt reaches one terminal owner.
      phase = "finalizing";
      finalization = (async () => {
        await params.drainQueue();
        await Promise.resolve();
        // Seal inside the stable-tail check. An SDK callback either extends the
        // queue before this point or observes the terminal phase and cannot defer.
        await params.drainQueue(() => {
          phase = "finalized";
          params.markReplayInvalid();
          params.abandonPendingTools();
        });
        const deferred = await flushDeferred(true);
        await params.publish(deferred.appended);
        for (const receipt of deferred.persistedReceipts) {
          receipt.resolve();
        }
        for (const eventId of acceptedEventIds) {
          rejectTerminalSdkUserEvent(eventId);
        }
        acceptedEventIds.clear();
      })();
      await finalization;
    },
  };
}
