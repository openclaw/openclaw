export type KeyedAsyncQueueHooks = {
    onEnqueue?: () => void;
    onSettle?: () => void;
};
/** Serialize async work per key while allowing unrelated keys to run concurrently. */
export declare function enqueueKeyedTask<T>(params: {
    tails: Map<string, Promise<void>>;
    key: string;
    task: () => Promise<T>;
    hooks?: KeyedAsyncQueueHooks;
}): Promise<T>;
export declare class KeyedAsyncQueue {
    private readonly tails;
    getTailMapForTesting(): Map<string, Promise<void>>;
    enqueue<T>(key: string, task: () => Promise<T>, hooks?: KeyedAsyncQueueHooks): Promise<T>;
}
