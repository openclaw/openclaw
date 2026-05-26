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
