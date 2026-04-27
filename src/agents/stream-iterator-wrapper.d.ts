type StreamIterator<T> = AsyncIterator<T, unknown, unknown>;
type IteratorHandler<T> = (iterator: StreamIterator<T>, value?: unknown) => IteratorResult<T, unknown> | Promise<IteratorResult<T, unknown>>;
export declare function createStreamIteratorWrapper<T>(params: {
    iterator: StreamIterator<T>;
    next: (iterator: StreamIterator<T>) => Promise<IteratorResult<T, unknown>>;
    onReturn?: IteratorHandler<T>;
    onThrow?: IteratorHandler<T>;
}): AsyncIterableIterator<T>;
export {};
