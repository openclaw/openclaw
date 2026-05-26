export type LazyPromiseLoader<T> = {
    load(): Promise<T>;
    clear(): void;
};
export type LazyPromiseLoaderOptions = {
    cacheRejections?: boolean;
};
export declare function createLazyPromiseLoader<T>(load: () => T | Promise<T>, options?: LazyPromiseLoaderOptions): LazyPromiseLoader<T>;
export declare function createLazyImportLoader<T>(load: () => Promise<T>, options?: LazyPromiseLoaderOptions): LazyPromiseLoader<T>;
