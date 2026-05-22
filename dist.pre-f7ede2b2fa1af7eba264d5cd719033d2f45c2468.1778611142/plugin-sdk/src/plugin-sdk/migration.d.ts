import type { MigrationDetection, MigrationItem, MigrationPlan, MigrationProviderContext, MigrationProviderPlugin, MigrationSummary } from "../plugins/types.js";
export type { MigrationDetection, MigrationItem, MigrationPlan, MigrationProviderContext, MigrationProviderPlugin, MigrationSummary, };
export declare const MIGRATION_REASON_MISSING_SOURCE_OR_TARGET = "missing source or target";
export declare const MIGRATION_REASON_TARGET_EXISTS = "target exists";
export declare function createMigrationItem(params: Omit<MigrationItem, "status"> & {
    status?: MigrationItem["status"];
}): MigrationItem;
export declare function markMigrationItemConflict(item: MigrationItem, reason: string): MigrationItem;
export declare function markMigrationItemError(item: MigrationItem, reason: string): MigrationItem;
export declare function markMigrationItemSkipped(item: MigrationItem, reason: string): MigrationItem;
export declare function summarizeMigrationItems(items: readonly MigrationItem[]): MigrationSummary;
export type MigrationConfigPatchDetails = {
    path: string[];
    value: unknown;
};
export declare function readMigrationConfigPath(root: Record<string, unknown>, path: readonly string[]): unknown;
export declare function mergeMigrationConfigValue(left: unknown, right: unknown): unknown;
export declare function writeMigrationConfigPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void;
export declare function hasMigrationConfigPatchConflict(config: MigrationProviderContext["config"], path: readonly string[], value: unknown): boolean;
export declare function createMigrationConfigPatchItem(params: {
    id: string;
    target: string;
    path: string[];
    value: unknown;
    message: string;
    conflict?: boolean;
    reason?: string;
    source?: string;
    details?: Record<string, unknown>;
}): MigrationItem;
export declare function createMigrationManualItem(params: {
    id: string;
    source: string;
    message: string;
    recommendation: string;
}): MigrationItem;
export declare function readMigrationConfigPatchDetails(item: MigrationItem): MigrationConfigPatchDetails | undefined;
export declare function applyMigrationConfigPatchItem(ctx: MigrationProviderContext, item: MigrationItem): Promise<MigrationItem>;
export declare function applyMigrationManualItem(item: MigrationItem): MigrationItem;
export declare function redactMigrationValue(value: unknown): unknown;
export declare function redactMigrationItem(item: MigrationItem): MigrationItem;
export declare function redactMigrationPlan<T extends MigrationPlan>(plan: T): T;
