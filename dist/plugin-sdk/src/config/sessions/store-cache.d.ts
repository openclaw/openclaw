import type { SessionEntry } from "./types.js";
export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer U)[] ? ReadonlyArray<DeepReadonly<U>> : T extends object ? {
    readonly [K in keyof T]: DeepReadonly<T[K]>;
} : T;
export type SessionStoreSnapshot = DeepReadonly<Record<string, SessionEntry>>;
export type SessionStoreSnapshotEntry = DeepReadonly<SessionEntry>;
export type SessionStoreSnapshotEntries = ReadonlyArray<readonly [string, SessionStoreSnapshotEntry]>;
export declare function internSessionEntryLargeStrings(entry: SessionEntry): void;
export declare function internSessionStoreLargeStrings(store: Record<string, SessionEntry>): void;
export declare function getSessionStoreStringInternStatsForTest(): {
    poolSize: number;
    stored: number;
    reused: number;
    skippedSmall: number;
    skippedFull: number;
    minChars: number;
    maxEntries: number;
};
export declare function getSerializedSessionStoreCacheStatsForTest(): {
    entries: number;
    totalBytes: number;
    maxEntries: number;
    maxBytes: number;
};
export declare function cloneSessionStoreRecord(store: Record<string, SessionEntry>, serialized?: string): Record<string, SessionEntry>;
export declare function cloneSessionStoreSnapshot(store: Record<string, SessionEntry>, serialized?: string): SessionStoreSnapshot;
export declare function getSessionStoreTtl(): number;
export declare function isSessionStoreCacheEnabled(): boolean;
export declare function clearSessionStoreCaches(): void;
export declare function invalidateSessionStoreCache(storePath: string): void;
export declare function getSerializedSessionStore(storePath: string): string | undefined;
export declare function setSerializedSessionStore(storePath: string, serialized?: string): void;
export declare function dropSessionStoreObjectCache(storePath: string): void;
export declare function dropSessionStoreSnapshotCache(storePath: string): void;
export declare function readSessionStoreSnapshotCache(params: {
    storePath: string;
    mtimeMs?: number;
    sizeBytes?: number;
}): SessionStoreSnapshot | null;
export declare function writeSessionStoreSnapshotCache(params: {
    storePath: string;
    store: Record<string, SessionEntry>;
    mtimeMs?: number;
    sizeBytes?: number;
    serialized?: string;
}): SessionStoreSnapshot;
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
