import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type {
  QaBusEvent,
  QaBusMessage,
  QaBusStateSnapshot,
  QaBusThread,
  QaBusWaitForInput,
} from "openclaw/plugin-sdk/qa-channel-protocol";

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

export function throwQaBusClosed(): never {
  throw new Error("qa-bus closed");
}

export type QaBusWaitMatch = QaBusEvent | QaBusMessage | QaBusThread;

type Waiter = {
  settle: (snapshot: QaBusStateSnapshot) => boolean;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function createQaBusMatcher(
  input: QaBusWaitForInput,
): (snapshot: QaBusStateSnapshot) => QaBusWaitMatch | null {
  return (snapshot) => {
    if (input.kind === "event-kind") {
      return snapshot.events.find((event) => event.kind === input.eventKind) ?? null;
    }
    if (input.kind === "thread-id") {
      return snapshot.threads.find((thread) => thread.id === input.threadId) ?? null;
    }
    return (
      snapshot.messages.find(
        (message) =>
          !message.deleted &&
          (!input.direction || message.direction === input.direction) &&
          message.text.includes(input.textIncludes),
      ) ?? null
    );
  };
}

export function createQaBusWaiterStore(getSnapshot: () => QaBusStateSnapshot) {
  const waiters = new Set<Waiter>();
  const cursorWaiters = new Set<Waiter>();
  const pendingSets = [waiters, cursorWaiters];
  let readSnapshot = getSnapshot;

  const waitForMatch = async <T>(
    pending: Set<Waiter>,
    matcher: (snapshot: QaBusStateSnapshot) => T | null,
    timeoutMs: number | undefined,
  ): Promise<T> => {
    const immediate = matcher(readSnapshot());
    if (immediate !== null) {
      return immediate;
    }
    const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 0);
    return await new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        settle(snapshot) {
          const match = matcher(snapshot);
          if (match === null) {
            return false;
          }
          resolve(match);
          return true;
        },
        reject,
        timer: setTimeout(() => {
          pending.delete(waiter);
          reject(new Error(`qa-bus wait timeout after ${resolvedTimeoutMs}ms`));
        }, resolvedTimeoutMs),
      };
      pending.add(waiter);
    });
  };

  return {
    reset(reason = "qa-bus reset", terminal = false) {
      readSnapshot = terminal ? throwQaBusClosed : readSnapshot;
      for (const pending of pendingSets) {
        for (const waiter of pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(reason));
        }
        pending.clear();
      }
    },
    settle() {
      if (waiters.size === 0 && cursorWaiters.size === 0) {
        return;
      }
      const snapshot = readSnapshot();
      for (const pending of pendingSets) {
        for (const waiter of Array.from(pending)) {
          if (waiter.settle(snapshot)) {
            clearTimeout(waiter.timer);
            pending.delete(waiter);
          }
        }
      }
    },
    waitFor(input: QaBusWaitForInput) {
      return waitForMatch(waiters, createQaBusMatcher(input), input.timeoutMs);
    },
    async waitForCursorAdvance(
      afterCursor: number,
      timeoutMs: number,
      shouldResolve?: (snapshot: QaBusStateSnapshot) => boolean,
    ) {
      await waitForMatch(
        cursorWaiters,
        (snapshot) =>
          snapshot.cursor > afterCursor && (!shouldResolve || shouldResolve(snapshot))
            ? true
            : null,
        timeoutMs,
      );
    },
  };
}
