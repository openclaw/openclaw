/**
 * Ordering for native stream work. Each update's compute -> append -> commit
 * runs as one task, since delta state commits only after Slack accepts it.
 * In cards mode a compositor publish can land while a task runs (a card
 * released from inside a send, an event during a Slack call); it must not
 * wait for the task it is part of, and a release from inside the pacing
 * loop's send must not wait for the startup flush that holds that send.
 */
export function createSlackNativeStreamOrder() {
  let tail: Promise<unknown> = Promise.resolve();
  let depth = 0;
  let flushesPending = 0;
  let flushesSettled: Promise<void> = Promise.resolve();
  let settleFlushes: (() => void) | undefined;
  let loopSendInFlight = false;
  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const ordered = async () => {
      depth += 1;
      try {
        return await task();
      } finally {
        depth -= 1;
      }
    };
    const next = tail.then(ordered, ordered);
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    run,
    /** The pacing loop's send: a release inside it never waits on a flush. */
    runLoopSend: <T>(task: () => Promise<T>): Promise<T> =>
      run(async () => {
        loopSendInFlight = true;
        try {
          return await task();
        } finally {
          loopSendInFlight = false;
        }
      }),
    get inTask() {
      return depth > 0;
    },
    async trackFlush(flush: () => Promise<unknown>): Promise<void> {
      flushesPending += 1;
      if (flushesPending === 1) {
        flushesSettled = new Promise<void>((resolve) => {
          settleFlushes = resolve;
        });
      }
      try {
        await flush();
      } finally {
        flushesPending -= 1;
        if (flushesPending === 0) {
          settleFlushes?.();
          settleFlushes = undefined;
        }
      }
    },
    /** False when a release must wait for the next paced send. */
    async waitForFlushes(): Promise<boolean> {
      if (flushesPending > 0) {
        if (loopSendInFlight) {
          return false;
        }
        await flushesSettled;
      }
      return true;
    },
  };
}
