import type { SessionEntry } from "./types.js";
export declare function cloneSessionStoreRecord(store: Record<string, SessionEntry>, serialized?: string): Record<string, SessionEntry>;
export declare function getSessionStoreTtl(): number;
export declare function isSessionStoreCacheEnabled(): boolean;
export declare function clearSessionStoreCaches(): void;
export declare function invalidateSessionStoreCache(storePath: string): void;
export declare function getSerializedSessionStore(storePath: string): string | undefined;
export declare function setSerializedSessionStore(storePath: string, serialized?: string): void;
export declare function dropSessionStoreObjectCache(storePath: string): void;
export declare function readSessionStoreCache(params: {
    storePath: string;
    mtimeMs?: number;
    sizeBytes?: number;
    clone?: boolean;
}): Record<string, SessionEntry> | null;
export declare function takeMutableSessionStoreCache(params: {
    storePath: string;
    mtimeMs?: number;
    sizeBytes?: number;
}): Record<string, SessionEntry> | null;
export declare function writeSessionStoreCache(params: {
    storePath: string;
    store: Record<string, SessionEntry>;
    mtimeMs?: number;
    sizeBytes?: number;
    serialized?: string;
}): void;
