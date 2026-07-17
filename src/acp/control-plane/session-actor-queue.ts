/** Per-session async queue wrapper used by ACP manager operations. */
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";

type SessionActorTaskContext = {
  generation: number;
  isStale: () => boolean;
};

/** Per-session async queue that serializes ACP runtime operations and exposes queue depth. */
export class SessionActorQueue {
  private readonly queue = new KeyedAsyncQueue();
  private readonly pendingBySession = new Map<string, number>();
  private readonly generationBySession = new Map<string, number>();

  getTotalPendingCount(): number {
    let total = 0;
    for (const count of this.pendingBySession.values()) {
      total += count;
    }
    return total;
  }

  retire(actorKey: string): void {
    if (!this.pendingBySession.has(actorKey)) {
      return;
    }
    this.generationBySession.set(actorKey, this.resolveGeneration(actorKey) + 1);
  }

  isCurrent(actorKey: string, generation: number): boolean {
    return this.resolveGeneration(actorKey) === generation;
  }

  async run<T>(actorKey: string, op: (context: SessionActorTaskContext) => Promise<T>): Promise<T> {
    const generation = this.resolveGeneration(actorKey);
    // A retired generation must not share the old promise tail: force-discard
    // uses this split so fresh work can start while the poisoned task is stuck.
    const queueKey = `${actorKey}\u0000${generation}`;
    return this.queue.enqueue(
      queueKey,
      async () =>
        await op({
          generation,
          isStale: () => !this.isCurrent(actorKey, generation),
        }),
      {
        onEnqueue: () => {
          this.pendingBySession.set(actorKey, (this.pendingBySession.get(actorKey) ?? 0) + 1);
        },
        onSettle: () => {
          // Keep queue-depth accounting symmetric with enqueue even when operations reject.
          const pending = (this.pendingBySession.get(actorKey) ?? 1) - 1;
          if (pending <= 0) {
            this.pendingBySession.delete(actorKey);
            // No task can still observe an old generation after the final
            // settle, so release the per-session fencing record as well.
            this.generationBySession.delete(actorKey);
          } else {
            this.pendingBySession.set(actorKey, pending);
          }
        },
      },
    );
  }

  private resolveGeneration(actorKey: string): number {
    return this.generationBySession.get(actorKey) ?? 0;
  }
}
