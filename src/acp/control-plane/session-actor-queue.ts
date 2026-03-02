import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";

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

  async run<T>(actorKey: string, op: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(actorKey, op, {
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
    });
  }
}
