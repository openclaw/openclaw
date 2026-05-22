import type { OpenClawConfig } from "../types.openclaw.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import { type ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import { type SessionStoreTarget, type SessionStoreSelectionOptions } from "./targets.js";
import type { SessionEntry } from "./types.js";
export type SessionsCleanupOptions = SessionStoreSelectionOptions & {
    dryRun?: boolean;
    enforce?: boolean;
    activeKey?: string;
    json?: boolean;
    fixMissing?: boolean;
};
export type SessionCleanupAction = "keep" | "prune-missing" | "prune-stale" | "cap-overflow" | "evict-budget";
export type SessionCleanupSummary = {
    agentId: string;
    storePath: string;
    mode: ResolvedSessionMaintenanceConfig["mode"];
    dryRun: boolean;
    beforeCount: number;
    afterCount: number;
    missing: number;
    pruned: number;
    capped: number;
    diskBudget: Awaited<ReturnType<typeof enforceSessionDiskBudget>>;
    wouldMutate: boolean;
    applied?: true;
    appliedCount?: number;
};
export type SessionsCleanupResult = SessionCleanupSummary | {
    allAgents: true;
    mode: ResolvedSessionMaintenanceConfig["mode"];
    dryRun: boolean;
    stores: SessionCleanupSummary[];
};
export type SessionsCleanupRunResult = {
    mode: ResolvedSessionMaintenanceConfig["mode"];
    previewResults: Array<{
        summary: SessionCleanupSummary;
        beforeStore: Record<string, SessionEntry>;
        missingKeys: Set<string>;
        staleKeys: Set<string>;
        cappedKeys: Set<string>;
        budgetEvictedKeys: Set<string>;
    }>;
    appliedSummaries: SessionCleanupSummary[];
};
export declare function resolveSessionCleanupAction(params: {
    key: string;
    missingKeys: Set<string>;
    staleKeys: Set<string>;
    cappedKeys: Set<string>;
    budgetEvictedKeys: Set<string>;
}): SessionCleanupAction;
export declare function serializeSessionCleanupResult(params: {
    mode: ResolvedSessionMaintenanceConfig["mode"];
    dryRun: boolean;
    summaries: SessionCleanupSummary[];
}): SessionsCleanupResult;
export declare function runSessionsCleanup(params: {
    cfg: OpenClawConfig;
    opts: SessionsCleanupOptions;
    targets?: SessionStoreTarget[];
}): Promise<SessionsCleanupRunResult>;
/** Purge session store entries for a deleted agent (#65524). Best-effort. */
export declare function purgeAgentSessionStoreEntries(cfg: OpenClawConfig, agentId: string): Promise<void>;
