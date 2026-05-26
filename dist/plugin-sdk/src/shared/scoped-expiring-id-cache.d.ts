export type ScopedExpiringIdCache<TScope extends string | number, TId extends string | number> = {
    record: (scope: TScope, id: TId, now?: number) => void;
    has: (scope: TScope, id: TId, now?: number) => boolean;
    clear: () => void;
};
export declare function createScopedExpiringIdCache<TScope extends string | number, TId extends string | number>(options: {
    store: Map<string, Map<string, number>>;
    ttlMs: number;
    cleanupThreshold: number;
}): ScopedExpiringIdCache<TScope, TId>;
