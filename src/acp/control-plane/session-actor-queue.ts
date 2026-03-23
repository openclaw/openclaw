import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";

export class SessionActorQueueTimeoutError extends Error {
  readonly actorKey: string;
  readonly timeoutMs: number;

  constructor(actorKey: string, timeoutMs: number) {
    super(`ACP session lane task timed out after ${timeoutMs}ms for ${actorKey}.`);
    this.name = "SessionActorQueueTimeoutError";
    this.actorKey = actorKey;
    this.timeoutMs = timeoutMs;
  }
}

function runWithTaskTimeout<T>(params: {
  actorKey: string;
  timeoutMs?: number;
  op: () => Promise<T>;
}): Promise<T> {
  const timeoutMs = params.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return params.op();
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new SessionActorQueueTimeoutError(params.actorKey, timeoutMs));
    }, timeoutMs);

    void params.op().then(
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
    op: () => Promise<T>,
    options?: {
      timeoutMs?: number;
    },
  ): Promise<T> {
    return this.queue.enqueue(
      actorKey,
      () =>
        runWithTaskTimeout({
          actorKey,
          timeoutMs: options?.timeoutMs,
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
