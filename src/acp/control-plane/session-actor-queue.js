import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
export class SessionActorQueue {
    queue = new KeyedAsyncQueue();
    pendingBySession = new Map();
    getTailMapForTesting() {
        return this.queue.getTailMapForTesting();
    }
    getTotalPendingCount() {
        let total = 0;
        for (const count of this.pendingBySession.values()) {
            total += count;
        }
        return total;
    }
    getPendingCountForSession(actorKey) {
        return this.pendingBySession.get(actorKey) ?? 0;
    }
    async run(actorKey, op) {
        return this.queue.enqueue(actorKey, op, {
            onEnqueue: () => {
                this.pendingBySession.set(actorKey, (this.pendingBySession.get(actorKey) ?? 0) + 1);
            },
            onSettle: () => {
                const pending = (this.pendingBySession.get(actorKey) ?? 1) - 1;
                if (pending <= 0) {
                    this.pendingBySession.delete(actorKey);
                }
                else {
                    this.pendingBySession.set(actorKey, pending);
                }
            },
        });
    }
}
