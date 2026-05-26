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
export declare const DEFAULT_QUOTA_SUSPENSION_TTL_MS: number;
export interface QuotaSuspensionMaintenanceResult {
    /** Suspensions whose state was advanced from "suspended" to "resuming" so the next attempt injects a handoff. */
    resumed: Array<{
        sessionKey: string;
        laneId?: string;
    }>;
    /** Entries whose `quotaSuspension` field was removed entirely (already-resumed records past 2x TTL). */
    cleared: number;
}
/**
 * Two-stage TTL maintenance for `quotaSuspension` records:
 *  1. After `ttlMs`, transition `state: "suspended" → "resuming"` so the next
 *     attempt for that session sees the resume marker and injects a handoff.
 *  2. After `2 * ttlMs`, drop the field entirely (the record has done its job).
 *
 * Mutates `store` in-place. The caller is responsible for translating the
 * returned `resumed[]` into in-process lane-concurrency restoration calls,
 * which keeps this module free of `process/*` dependencies.
 */
export declare function pruneQuotaSuspensions(params: {
    store: Record<string, SessionEntry>;
    now: number;
    ttlMs?: number;
    log?: boolean;
}): QuotaSuspensionMaintenanceResult;
export declare function isProtectedSessionMaintenanceEntry(sessionKey: string, entry: SessionEntry | undefined): boolean;
export declare function shouldPreserveMaintenanceEntry(params: {
    key: string;
    entry: SessionEntry | undefined;
    preserveKeys?: ReadonlySet<string>;
}): boolean;
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
