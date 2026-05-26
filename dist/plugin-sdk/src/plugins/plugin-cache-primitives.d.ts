import type { OpenClawConfig } from "../config/types.openclaw.js";
export type PluginLruCacheResult<T> = {
    hit: true;
    value: T;
} | {
    hit: false;
};
export declare class PluginLruCache<T> {
    #private;
    constructor(defaultMaxEntries: number);
    get maxEntries(): number;
    get size(): number;
    setMaxEntriesForTest(value?: number): void;
    clear(): void;
    get(cacheKey: string): T | undefined;
    getResult(cacheKey: string): PluginLruCacheResult<T>;
    set(cacheKey: string, value: T): void;
}
export type ConfigScopedRuntimeCache<T> = WeakMap<OpenClawConfig, Map<string, T>>;
export type ConfigScopedPromiseLoader<T> = {
    load(config?: OpenClawConfig): Promise<T>;
    clear(): void;
};
export declare function resolveConfigScopedRuntimeCacheValue<T>(params: {
    cache: ConfigScopedRuntimeCache<T>;
    config?: OpenClawConfig;
    key: string;
    load: () => T;
}): T;
export declare function createPluginCacheKey(parts: readonly unknown[]): string;
export declare function createConfigScopedPromiseLoader<T>(load: (config?: OpenClawConfig) => T | Promise<T>): ConfigScopedPromiseLoader<T>;
