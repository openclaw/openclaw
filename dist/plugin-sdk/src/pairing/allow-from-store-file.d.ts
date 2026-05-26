import type { PairingChannel } from "./pairing-store.types.js";
export type AllowFromStore = {
    version: 1;
    allowFrom: string[];
};
type AllowFromReadCacheEntry = {
    exists: boolean;
    mtimeMs: number | null;
    size: number | null;
    entries: string[];
};
type NormalizeAllowFromStore = (store: AllowFromStore) => string[];
export declare function resolvePairingCredentialsDir(env?: NodeJS.ProcessEnv): string;
/** Sanitize channel ID for use in filenames (prevent path traversal). */
export declare function safeChannelKey(channel: PairingChannel): string;
export declare function resolveAllowFromFilePath(channel: PairingChannel, env?: NodeJS.ProcessEnv, accountId?: string): string;
export declare function dedupePreserveOrder(entries: string[]): string[];
export declare function shouldIncludeLegacyAllowFromEntries(normalizedAccountId: string): boolean;
export declare function resolveAllowFromAccountId(accountId?: string): string;
export declare function setAllowFromFileReadCache(params: {
    cacheNamespace: string;
    filePath: string;
    entry: AllowFromReadCacheEntry;
}): void;
export declare function readAllowFromFileWithExists(params: {
    cacheNamespace: string;
    filePath: string;
    normalizeStore: NormalizeAllowFromStore;
}): Promise<{
    entries: string[];
    exists: boolean;
}>;
export declare function readAllowFromFileSyncWithExists(params: {
    cacheNamespace: string;
    filePath: string;
    normalizeStore: NormalizeAllowFromStore;
}): {
    entries: string[];
    exists: boolean;
};
export declare function clearAllowFromFileReadCacheForNamespace(cacheNamespace: string): void;
export {};
