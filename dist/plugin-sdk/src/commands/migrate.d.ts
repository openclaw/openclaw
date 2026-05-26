import type { MigrationApplyResult, MigrationPlan } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { MigrateApplyOptions, MigrateCommonOptions, MigrateDefaultOptions } from "./migrate/types.js";
export type { MigrateApplyOptions, MigrateCommonOptions, MigrateDefaultOptions };
export declare function migrateListCommand(runtime: RuntimeEnv, opts?: {
    json?: boolean;
}): Promise<void>;
export declare function migratePlanCommand(runtime: RuntimeEnv, opts: MigrateCommonOptions): Promise<MigrationPlan>;
export declare function migrateApplyCommand(runtime: RuntimeEnv, opts: MigrateApplyOptions & {
    yes: true;
}): Promise<MigrationApplyResult>;
export declare function migrateApplyCommand(runtime: RuntimeEnv, opts: MigrateApplyOptions): Promise<MigrationApplyResult | MigrationPlan>;
export declare function migrateDefaultCommand(runtime: RuntimeEnv, opts: MigrateDefaultOptions): Promise<MigrationPlan | MigrationApplyResult>;
