export class RuntimeCache {
    cache = new Map();
    size() {
        return this.cache.size;
    }
    has(actorKey) {
        return this.cache.has(actorKey);
    }
    get(actorKey, params = {}) {
        const entry = this.cache.get(actorKey);
        if (!entry) {
            return null;
        }
        if (params.touch !== false) {
            entry.lastTouchedAt = params.now ?? Date.now();
        }
        return entry.state;
    }
    peek(actorKey) {
        return this.get(actorKey, { touch: false });
    }
    getLastTouchedAt(actorKey) {
        return this.cache.get(actorKey)?.lastTouchedAt ?? null;
    }
    set(actorKey, state, params = {}) {
        this.cache.set(actorKey, {
            state,
            lastTouchedAt: params.now ?? Date.now(),
        });
    }
    clear(actorKey) {
        this.cache.delete(actorKey);
    }
    snapshot(params = {}) {
        const now = params.now ?? Date.now();
        const entries = [];
        for (const [actorKey, entry] of this.cache.entries()) {
            entries.push({
                actorKey,
                state: entry.state,
                lastTouchedAt: entry.lastTouchedAt,
                idleMs: Math.max(0, now - entry.lastTouchedAt),
            });
        }
        return entries;
    }
    collectIdleCandidates(params) {
        if (!Number.isFinite(params.maxIdleMs) || params.maxIdleMs <= 0) {
            return [];
        }
        const now = params.now ?? Date.now();
        return this.snapshot({ now }).filter((entry) => entry.idleMs >= params.maxIdleMs);
    }
}
