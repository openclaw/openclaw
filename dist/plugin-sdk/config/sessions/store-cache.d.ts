import type { SessionEntry } from "./types.js";
export declare function clearSessionStoreCaches(): void;
export declare function invalidateSessionStoreCache(storePath: string): void;
export declare function getSerializedSessionStore(storePath: string): string | undefined;
export declare function setSerializedSessionStore(storePath: string, serialized?: string): void;
export declare function dropSessionStoreObjectCache(storePath: string): void;
export declare function readSessionStoreCache(params: {
    storePath: string;
    ttlMs: number;
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
