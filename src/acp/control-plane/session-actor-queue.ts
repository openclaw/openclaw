import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";

export type SessionActorQueueDiagnosticSnapshot = {
  actorKey: string;
  enqueueTime: number;
  actorStarted: boolean;
  settleTime: number | null;
  abortBeforeStart: boolean;
  previousTailPresent: boolean;
  previousTailAgeMs: number | null;
  pendingCount: number;
  tailPresent: boolean;
};

type SessionActorQueueDiagnosticState = Omit<
  SessionActorQueueDiagnosticSnapshot,
  "pendingCount" | "tailPresent"
>;

export type SessionActorQueueRunOptions = {
  /**
   * Optional cancellation signal. When the signal aborts before the queued
   * item reaches the head of the queue, the item is marked cancelled:
   * - The item's slot in the per-key chain is preserved (serialization holds)
   * - `op()` is NOT called when the chain reaches the cancelled slot
   * - `pendingBySession` is decremented exactly once, immediately on abort
   * - The returned promise rejects with a DOMException of name "AbortError"
   * If the signal aborts after the actor has started, the cancellation has
   * no effect on the running op; the caller is responsible for honoring the
   * signal inside `op()`.
   */
  signal?: AbortSignal;
};

function makeAbortError(): DOMException {
  return new DOMException("Aborted before start", "AbortError");
}

export class SessionActorQueue {
  private readonly queue = new KeyedAsyncQueue();
  private readonly pendingBySession = new Map<string, number>();
  private readonly diagnosticsBySession = new Map<string, SessionActorQueueDiagnosticState>();

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

  getDiagnosticSnapshot(actorKey: string): SessionActorQueueDiagnosticSnapshot | null {
    const diagnostic = this.diagnosticsBySession.get(actorKey);
    if (!diagnostic) {
      return null;
    }
    return {
      ...diagnostic,
      pendingCount: this.getPendingCountForSession(actorKey),
      tailPresent: this.queue.getTailMapForTesting().has(actorKey),
    };
  }

  markAbortBeforeStart(actorKey: string): void {
    const diagnostic = this.diagnosticsBySession.get(actorKey);
    if (!diagnostic) {
      return;
    }
    this.diagnosticsBySession.set(actorKey, {
      ...diagnostic,
      abortBeforeStart: true,
    });
  }

  private decrementPendingFor(actorKey: string): void {
    const pending = (this.pendingBySession.get(actorKey) ?? 1) - 1;
    if (pending <= 0) {
      this.pendingBySession.delete(actorKey);
    } else {
      this.pendingBySession.set(actorKey, pending);
    }
  }

  async run<T>(
    actorKey: string,
    op: () => Promise<T>,
    options?: SessionActorQueueRunOptions,
  ): Promise<T> {
    const now = Date.now();
    const previous = this.diagnosticsBySession.get(actorKey);
    const previousTailPresent = this.queue.getTailMapForTesting().has(actorKey);
    const previousTailAgeMs =
      previousTailPresent && previous ? Math.max(0, now - previous.enqueueTime) : null;

    // Per-item state, captured in this closure. We deliberately do not put
    // these flags on the per-actorKey diagnostic state, because the diagnostic
    // map is overwritten by each newer enqueue. Each call to run() owns its
    // own item flags.
    const itemState = {
      cancelled: false,
      actorStarted: false,
      pendingDecremented: false,
    };

    const decrementOnce = () => {
      if (itemState.pendingDecremented) {
        return;
      }
      itemState.pendingDecremented = true;
      this.decrementPendingFor(actorKey);
    };

    const signal = options?.signal;
    let onAbort: (() => void) | null = null;
    if (signal) {
      onAbort = () => {
        if (itemState.actorStarted) {
          // Caller must honor the signal inside op(); we do not interfere.
          return;
        }
        if (itemState.cancelled) {
          return;
        }
        itemState.cancelled = true;
        // Reflect cancellation in the per-key diagnostic state, matching the
        // existing markAbortBeforeStart semantics so observability remains
        // consistent across both the manager-level and queue-level paths.
        const diagnostic = this.diagnosticsBySession.get(actorKey);
        if (diagnostic) {
          this.diagnosticsBySession.set(actorKey, {
            ...diagnostic,
            abortBeforeStart: true,
          });
        }
        // Decrement pending eagerly so observability does not stay inflated
        // while we wait for the predecessor tail to settle.
        decrementOnce();
      };
      if (signal.aborted) {
        // Pre-aborted: mark cancelled before we even enqueue. The wrapped task
        // will reject with AbortError when it runs; pending decrement happens
        // eagerly in onAbort below (called synchronously after enqueue).
        itemState.cancelled = true;
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const cleanupSignal = () => {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    try {
      const result = await this.queue.enqueue(
        actorKey,
        async () => {
          if (itemState.cancelled) {
            // Caller aborted before the actor reached the head of the queue.
            // Skip op() entirely so cancellation has zero side effect on the
            // protected resource. onSettle below still fires for the wrapped
            // task itself, which is why decrementOnce is idempotent.
            throw makeAbortError();
          }
          itemState.actorStarted = true;
          const diagnostic = this.diagnosticsBySession.get(actorKey);
          if (diagnostic) {
            this.diagnosticsBySession.set(actorKey, {
              ...diagnostic,
              actorStarted: true,
            });
          }
          return await op();
        },
        {
          onEnqueue: () => {
            this.pendingBySession.set(actorKey, (this.pendingBySession.get(actorKey) ?? 0) + 1);
            this.diagnosticsBySession.set(actorKey, {
              actorKey,
              enqueueTime: now,
              actorStarted: false,
              settleTime: null,
              abortBeforeStart: false,
              previousTailPresent,
              previousTailAgeMs,
            });
            // If we were pre-aborted at the start of run(), the listener path
            // didn't run because we never registered it. Decrement now so
            // pending stays in sync.
            if (itemState.cancelled && signal?.aborted) {
              const diagnostic = this.diagnosticsBySession.get(actorKey);
              if (diagnostic) {
                this.diagnosticsBySession.set(actorKey, {
                  ...diagnostic,
                  abortBeforeStart: true,
                });
              }
              decrementOnce();
            }
          },
          onSettle: () => {
            const diagnostic = this.diagnosticsBySession.get(actorKey);
            if (diagnostic) {
              this.diagnosticsBySession.set(actorKey, {
                ...diagnostic,
                settleTime: Date.now(),
              });
            }
            // decrementOnce is idempotent: safe whether we already decremented
            // eagerly on cancellation or this is the first time.
            decrementOnce();
          },
        },
      );
      return result;
    } finally {
      cleanupSignal();
    }
  }
}
