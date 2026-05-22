import type { SessionMaintenanceConfig, SessionMaintenanceMode } from "../types.base.js";
import type { SessionEntry } from "./types.js";
export type SessionMaintenanceWarning = {
    activeSessionKey: string;
    activeUpdatedAt?: number;
    totalEntries: number;
    pruneAfterMs: number;
    maxEntries: number;
    wouldPrune: boolean;
    wouldCap: boolean;
};
export type ResolvedSessionMaintenanceConfig = {
    mode: SessionMaintenanceMode;
    pruneAfterMs: number;
    maxEntries: number;
    resetArchiveRetentionMs: number | null;
    maxDiskBytes: number | null;
    highWaterBytes: number | null;
};
/**
 * Resolve maintenance settings from openclaw.json (`session.maintenance`).
 * Falls back to built-in defaults when config is missing or unset.
 */
export declare function resolveMaintenanceConfigFromInput(maintenance?: SessionMaintenanceConfig): ResolvedSessionMaintenanceConfig;
export declare function resolveSessionEntryMaintenanceHighWater(maxEntries: number): number;
export declare function shouldRunSessionEntryMaintenance(params: {
    entryCount: number;
    maxEntries: number;
    force?: boolean;
}): boolean;
/**
 * Remove entries whose `updatedAt` is older than the configured threshold.
 * Entries without `updatedAt` are kept (cannot determine staleness).
 * Mutates `store` in-place.
 */
export declare function pruneStaleEntries(store: Record<string, SessionEntry>, overrideMaxAgeMs?: number, opts?: {
    log?: boolean;
    onPruned?: (params: {
        key: string;
        entry: SessionEntry;
    }) => void;
    preserveKeys?: ReadonlySet<string>;
}): number;
export declare function isProtectedSessionMaintenanceEntry(sessionKey: string, entry: SessionEntry | undefined): boolean;
export declare function getActiveSessionMaintenanceWarning(params: {
    store: Record<string, SessionEntry>;
    activeSessionKey: string;
    pruneAfterMs: number;
    maxEntries: number;
    nowMs?: number;
}): SessionMaintenanceWarning | null;
/**
 * Cap the store to the N most recently updated entries.
 * Entries without `updatedAt` are sorted last (removed first when over limit).
 * Mutates `store` in-place.
 */
export declare function capEntryCount(store: Record<string, SessionEntry>, overrideMax?: number, opts?: {
    log?: boolean;
    onCapped?: (params: {
        key: string;
        entry: SessionEntry;
    }) => void;
    preserveKeys?: ReadonlySet<string>;
}): number;
