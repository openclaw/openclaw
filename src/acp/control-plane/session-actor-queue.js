export class SessionActorQueue {
    tailBySession = new Map();
    pendingBySession = new Map();
    getTailMapForTesting() {
        return this.tailBySession;
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
        const previous = this.tailBySession.get(actorKey) ?? Promise.resolve();
        this.pendingBySession.set(actorKey, (this.pendingBySession.get(actorKey) ?? 0) + 1);
        let release = () => { };
        const marker = new Promise((resolve) => {
            release = resolve;
        });
        const queuedTail = previous
            .catch(() => {
            // Keep actor queue alive after an operation failure.
        })
            .then(() => marker);
        this.tailBySession.set(actorKey, queuedTail);
        await previous.catch(() => {
            // Previous failures should not block newer commands.
        });
        try {
            return await op();
        }
        finally {
            const pending = (this.pendingBySession.get(actorKey) ?? 1) - 1;
            if (pending <= 0) {
                this.pendingBySession.delete(actorKey);
            }
            else {
                this.pendingBySession.set(actorKey, pending);
            }
            release();
            if (this.tailBySession.get(actorKey) === queuedTail) {
                this.tailBySession.delete(actorKey);
            }
        }
    }
}
