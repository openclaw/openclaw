import type { MsgContext } from "../../auto-reply/templating.js";
import { type DeliveryContext } from "../../utils/delivery-context.js";
import type { SessionMaintenanceMode } from "../types.base.js";
import { type SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { type SessionEntry } from "./types.js";
export declare function clearSessionStoreCacheForTest(): void;
/** Expose lock queue size for tests. */
export declare function getSessionStoreLockQueueSizeForTest(): number;
export declare function withSessionStoreLockForTest<T>(storePath: string, fn: () => Promise<T>, opts?: SessionStoreLockOptions): Promise<T>;
type LoadSessionStoreOptions = {
    skipCache?: boolean;
};
export declare function loadSessionStore(storePath: string, opts?: LoadSessionStoreOptions): Record<string, SessionEntry>;
export declare function readSessionUpdatedAt(params: {
    storePath: string;
    sessionKey: string;
}): number | undefined;
export type SessionMaintenanceWarning = {
    activeSessionKey: string;
    activeUpdatedAt?: number;
    totalEntries: number;
    pruneAfterMs: number;
    maxEntries: number;
    wouldPrune: boolean;
    wouldCap: boolean;
};
export type SessionMaintenanceApplyReport = {
    mode: SessionMaintenanceMode;
    beforeCount: number;
    afterCount: number;
    pruned: number;
    capped: number;
    diskBudget: SessionDiskBudgetSweepResult | null;
};
type ResolvedSessionMaintenanceConfig = {
    mode: SessionMaintenanceMode;
    pruneAfterMs: number;
    maxEntries: number;
    rotateBytes: number;
    resetArchiveRetentionMs: number | null;
    maxDiskBytes: number | null;
    highWaterBytes: number | null;
};
/**
 * Resolve maintenance settings from openclaw.json (`session.maintenance`).
 * Falls back to built-in defaults when config is missing or unset.
 */
export declare function resolveMaintenanceConfig(): ResolvedSessionMaintenanceConfig;
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
}): number;
export declare function getActiveSessionMaintenanceWarning(params: {
    store: Record<string, SessionEntry>;
    activeSessionKey: string;
    pruneAfterMs: number;
    maxEntries: number;
    nowMs?: number;
}): SessionMaintenanceWarning | null;
export declare function capEntryCount(store: Record<string, SessionEntry>, overrideMax?: number, opts?: {
    log?: boolean;
    onCapped?: (params: {
        key: string;
        entry: SessionEntry;
    }) => void;
}): number;
/**
 * Rotate the sessions file if it exceeds the configured size threshold.
 * Renames the current file to `sessions.json.bak.{timestamp}` and cleans up
 * old rotation backups, keeping only the 3 most recent `.bak.*` files.
 */
export declare function rotateSessionFile(storePath: string, overrideBytes?: number): Promise<boolean>;
type SaveSessionStoreOptions = {
    /** Skip pruning, capping, and rotation (e.g. during one-time migrations). */
    skipMaintenance?: boolean;
    /** Active session key for warn-only maintenance. */
    activeSessionKey?: string;
    /** Optional callback for warn-only maintenance. */
    onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
    /** Optional callback with maintenance stats after a save. */
    onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>;
    /** Optional overrides used by maintenance commands. */
    maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
};
export declare function saveSessionStore(storePath: string, store: Record<string, SessionEntry>, opts?: SaveSessionStoreOptions): Promise<void>;
export declare function updateSessionStore<T>(storePath: string, mutator: (store: Record<string, SessionEntry>) => Promise<T> | T, opts?: SaveSessionStoreOptions): Promise<T>;
type SessionStoreLockOptions = {
    timeoutMs?: number;
    pollIntervalMs?: number;
    staleMs?: number;
};
export declare function updateSessionStoreEntry(params: {
    storePath: string;
    sessionKey: string;
    update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null>;
export declare function recordSessionMetaFromInbound(params: {
    storePath: string;
    sessionKey: string;
    ctx: MsgContext;
    groupResolution?: import("./types.js").GroupKeyResolution | null;
    createIfMissing?: boolean;
}): Promise<SessionEntry | null>;
export declare function updateLastRoute(params: {
    storePath: string;
    sessionKey: string;
    channel?: SessionEntry["lastChannel"];
    to?: string;
    accountId?: string;
    threadId?: string | number;
    deliveryContext?: DeliveryContext;
    ctx?: MsgContext;
    groupResolution?: import("./types.js").GroupKeyResolution | null;
}): Promise<SessionEntry>;
export {};
