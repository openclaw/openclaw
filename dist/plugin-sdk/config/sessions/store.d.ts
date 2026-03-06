import type { MsgContext } from "../../auto-reply/templating.js";
import { type DeliveryContext } from "../../utils/delivery-context.js";
import { type SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { capEntryCount, getActiveSessionMaintenanceWarning, pruneStaleEntries, resolveMaintenanceConfig, rotateSessionFile, type ResolvedSessionMaintenanceConfig, type SessionMaintenanceWarning } from "./store-maintenance.js";
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
export type SessionMaintenanceApplyReport = {
    mode: ResolvedSessionMaintenanceConfig["mode"];
    beforeCount: number;
    afterCount: number;
    pruned: number;
    capped: number;
    diskBudget: SessionDiskBudgetSweepResult | null;
};
export { capEntryCount, getActiveSessionMaintenanceWarning, pruneStaleEntries, resolveMaintenanceConfig, rotateSessionFile, };
export type { ResolvedSessionMaintenanceConfig, SessionMaintenanceWarning };
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
