import { type SessionStoreSnapshot, type SessionStoreSnapshotEntries, type SessionStoreSnapshotEntry } from "./store-cache.js";
import { type ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import { type SessionEntry } from "./types.js";
export type LoadSessionStoreOptions = {
    skipCache?: boolean;
    maintenanceConfig?: ResolvedSessionMaintenanceConfig;
    runMaintenance?: boolean;
    clone?: boolean;
};
export declare function normalizeSessionStore(store: Record<string, SessionEntry>): boolean;
export declare function loadSessionStore(storePath: string, opts?: LoadSessionStoreOptions): Record<string, SessionEntry>;
export declare function readSessionStoreSnapshot(storePath: string): SessionStoreSnapshot;
export declare function readSessionEntry(storePath: string, sessionKey: string): SessionStoreSnapshotEntry | undefined;
export declare function readSessionEntries(storePath: string): SessionStoreSnapshotEntries;
