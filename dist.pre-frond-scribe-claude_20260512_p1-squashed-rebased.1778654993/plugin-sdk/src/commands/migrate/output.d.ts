import type { MigrationApplyResult, MigrationPlan } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { MigrateApplyOptions } from "./types.js";
export declare function formatMigrationPlan(plan: MigrationPlan): string[];
export declare function assertConflictFreePlan(plan: MigrationPlan, providerId: string): void;
export declare function writeApplyResult(runtime: RuntimeEnv, opts: MigrateApplyOptions, result: MigrationApplyResult): void;
export declare function assertApplySucceeded(result: MigrationApplyResult): void;
