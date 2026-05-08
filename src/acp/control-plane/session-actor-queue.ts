import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";

export class SessionActorQueueTimeoutError extends Error {
  readonly actorKey: string;
  readonly timeoutMs: number;

  constructor(actorKey: string, timeoutMs: number) {
    super(`ACP session lane task timed out after ${timeoutMs}ms.`);
    this.name = "SessionActorQueueTimeoutError";
    this.actorKey = actorKey;
    this.timeoutMs = timeoutMs;
  }
}

export const MAX_SESSION_ACTOR_QUEUE_TIMEOUT_MS = 2_147_483_647;

export type SessionActorQueueTaskContext = {
  signal: AbortSignal;
  isStale: () => boolean;
};

function clampTimerDelayMs(timeoutMs: number): number {
  return Math.min(MAX_SESSION_ACTOR_QUEUE_TIMEOUT_MS, Math.max(1, Math.round(timeoutMs)));
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== "object" || timer === null || !("unref" in timer)) {
    return;
  }
  (timer as { unref?: () => void }).unref?.();
}

function runWithTaskTimeout<T>(params: {
  actorKey: string;
  timeoutMs?: number;
  onTimeout?: () => void;
  op: (context: SessionActorQueueTaskContext) => Promise<T>;
}): Promise<T> {
  const timeoutMs = params.timeoutMs;
  const abortController = new AbortController();
  let stale = false;
  const context: SessionActorQueueTaskContext = {
    signal: abortController.signal,
    isStale: () => stale,
  };
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return params.op(context);
  }
  const timerDelayMs = clampTimerDelayMs(timeoutMs);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      stale = true;
      abortController.abort();
      try {
        params.onTimeout?.();
      } catch {
        // Timeout delivery must still reject the lane task.
      }
      reject(new SessionActorQueueTimeoutError(params.actorKey, timerDelayMs));
    }, timerDelayMs);
    unrefTimer(timer);

    void params.op(context).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class SessionActorQueue {
  private readonly queue = new KeyedAsyncQueue();
  private readonly pendingBySession = new Map<string, number>();

  getTailMapForTesting(): Map<string, Promise<void>> {
    return this.queue.getTailMapForTesting();
  }

  getTotalPendingCount(): number {
    let total = 0;
    for (const count of this.pendingBySession.values()) {
      total += count;
    }
    return total;
  }

  getPendingCountForSession(actorKey: string): number {
    return this.pendingBySession.get(actorKey) ?? 0;
  }

  async run<T>(
    actorKey: string,
    op: (context: SessionActorQueueTaskContext) => Promise<T>,
    options?: {
      timeoutMs?: number;
      onTimeout?: () => void;
    },
  ): Promise<T> {
    return this.queue.enqueue(
      actorKey,
      () =>
        runWithTaskTimeout({
          actorKey,
          timeoutMs: options?.timeoutMs,
          onTimeout: options?.onTimeout,
          op,
        }),
      {
        onEnqueue: () => {
          this.pendingBySession.set(actorKey, (this.pendingBySession.get(actorKey) ?? 0) + 1);
        },
        onSettle: () => {
          const pending = (this.pendingBySession.get(actorKey) ?? 1) - 1;
          if (pending <= 0) {
            this.pendingBySession.delete(actorKey);
          } else {
            this.pendingBySession.set(actorKey, pending);
          }
        },
      },
    );
  }
}
