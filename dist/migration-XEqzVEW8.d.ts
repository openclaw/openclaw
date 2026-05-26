import { _ as MigrationSummary, l as MigrationItem, m as MigrationProviderContext, p as MigrationPlan } from "./types-Vx7Jq4_-2.js";

//#region src/plugin-sdk/migration.d.ts
declare const MIGRATION_REASON_MISSING_SOURCE_OR_TARGET = "missing source or target";
declare const MIGRATION_REASON_TARGET_EXISTS = "target exists";
declare function createMigrationItem(params: Omit<MigrationItem, "status"> & {
  status?: MigrationItem["status"];
}): MigrationItem;
declare function markMigrationItemConflict(item: MigrationItem, reason: string): MigrationItem;
declare function markMigrationItemError(item: MigrationItem, reason: string): MigrationItem;
declare function markMigrationItemSkipped(item: MigrationItem, reason: string): MigrationItem;
declare function summarizeMigrationItems(items: readonly MigrationItem[]): MigrationSummary;
type MigrationConfigPatchDetails = {
  path: string[];
  value: unknown;
};
declare function readMigrationConfigPath(root: Record<string, unknown>, path: readonly string[]): unknown;
declare function mergeMigrationConfigValue(left: unknown, right: unknown): unknown;
declare function writeMigrationConfigPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void;
declare function hasMigrationConfigPatchConflict(config: MigrationProviderContext["config"], path: readonly string[], value: unknown): boolean;
declare function createMigrationConfigPatchItem(params: {
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
declare function createMigrationManualItem(params: {
  id: string;
  source: string;
  message: string;
  recommendation: string;
}): MigrationItem;
declare function readMigrationConfigPatchDetails(item: MigrationItem): MigrationConfigPatchDetails | undefined;
declare function applyMigrationConfigPatchItem(ctx: MigrationProviderContext, item: MigrationItem): Promise<MigrationItem>;
declare function applyMigrationManualItem(item: MigrationItem): MigrationItem;
declare function redactMigrationValue(value: unknown): unknown;
declare function redactMigrationItem(item: MigrationItem): MigrationItem;
declare function redactMigrationPlan<T extends MigrationPlan>(plan: T): T;
//#endregion
export { redactMigrationPlan as _, applyMigrationManualItem as a, writeMigrationConfigPath as b, createMigrationManualItem as c, markMigrationItemError as d, markMigrationItemSkipped as f, redactMigrationItem as g, readMigrationConfigPath as h, applyMigrationConfigPatchItem as i, hasMigrationConfigPatchConflict as l, readMigrationConfigPatchDetails as m, MIGRATION_REASON_TARGET_EXISTS as n, createMigrationConfigPatchItem as o, mergeMigrationConfigValue as p, MigrationConfigPatchDetails as r, createMigrationItem as s, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET as t, markMigrationItemConflict as u, redactMigrationValue as v, summarizeMigrationItems as y };