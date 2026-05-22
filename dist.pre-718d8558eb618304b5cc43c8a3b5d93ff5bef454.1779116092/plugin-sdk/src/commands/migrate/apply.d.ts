import type { MigrationApplyResult, MigrationProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { MigrateApplyOptions } from "./types.js";
export declare function createPreMigrationBackup(opts: {
    output?: string;
}): Promise<string | undefined>;
export declare function runMigrationApply(params: {
    runtime: RuntimeEnv;
    opts: MigrateApplyOptions;
    providerId: string;
    provider: MigrationProviderPlugin;
}): Promise<MigrationApplyResult>;
