type LazyValue<T> = T | (() => T);
export declare function createCachedLazyValueGetter<T>(value: LazyValue<T>): () => T;
export declare function createCachedLazyValueGetter<T>(value: LazyValue<T | null | undefined>, fallback: T): () => T;
export {};
