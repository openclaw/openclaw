import type { createJiti } from "jiti";
import { PluginLruCache } from "./plugin-cache-primitives.js";
import { type PluginSdkResolutionPreference } from "./sdk-alias.js";
export type PluginModuleLoader = ReturnType<typeof createJiti>;
export type PluginModuleLoaderFactory = typeof createJiti;
export type PluginModuleLoaderCache = Pick<PluginLruCache<PluginModuleLoader>, "clear" | "get" | "set" | "size">;
export type ResolvePluginModuleLoaderCacheEntryParams = {
    modulePath: string;
    importerUrl: string;
    argvEntry?: string;
    preferBuiltDist?: boolean;
    loaderFilename?: string;
    aliasMap?: Record<string, string>;
    tryNative?: boolean;
    pluginSdkResolution?: PluginSdkResolutionPreference;
    cacheScopeKey?: string;
    sharedCacheScopeKey?: string;
};
export type PluginModuleLoaderCacheEntry = {
    loaderFilename: string;
    aliasMap: Record<string, string>;
    tryNative: boolean;
    cacheKey: string;
    scopedCacheKey: string;
};
export type PluginModuleLoaderStatsSnapshot = {
    calls: number;
    nativeHits: number;
    nativeMisses: number;
    sourceTransformForced: number;
    sourceTransformFallbacks: number;
    topSourceTransformTargets: Array<{
        target: string;
        count: number;
    }>;
};
export declare function getPluginModuleLoaderStats(): PluginModuleLoaderStatsSnapshot;
export declare function resetPluginModuleLoaderStatsForTest(): void;
export declare function createPluginModuleLoaderCache(maxEntries?: number): PluginModuleLoaderCache;
export declare function resolvePluginModuleLoaderCacheEntry(params: ResolvePluginModuleLoaderCacheEntryParams): PluginModuleLoaderCacheEntry;
export declare function getCachedPluginModuleLoader(params: ResolvePluginModuleLoaderCacheEntryParams & {
    cache: PluginModuleLoaderCache;
    createLoader?: PluginModuleLoaderFactory;
}): PluginModuleLoader;
export declare function getCachedPluginSourceModuleLoader(params: Omit<Parameters<typeof getCachedPluginModuleLoader>[0], "tryNative">): PluginModuleLoader;
