import type { MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { MigrateCommonOptions } from "./types.js";
export declare function resolveMigrationProvider(providerId: string, config?: import("../../config/types.openclaw.ts").OpenClawConfig): MigrationProviderPlugin;
export declare function buildMigrationProviderOptions(opts: MigrateCommonOptions, providerId?: string | undefined): Record<string, unknown> | undefined;
export declare function createMigrationPlan(runtime: RuntimeEnv, opts: MigrateCommonOptions & {
    provider: string;
}): Promise<MigrationPlan>;
