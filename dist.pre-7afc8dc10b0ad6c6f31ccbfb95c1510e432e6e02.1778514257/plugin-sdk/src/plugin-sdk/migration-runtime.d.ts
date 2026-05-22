import type { MigrationApplyResult, MigrationItem, MigrationProviderContext } from "../plugins/types.js";
export type { MigrationApplyResult, MigrationItem } from "../plugins/types.js";
export declare function withCachedMigrationConfigRuntime(runtime: MigrationProviderContext["runtime"] | undefined, fallbackConfig: MigrationProviderContext["config"]): MigrationProviderContext["runtime"] | undefined;
export declare function archiveMigrationItem(item: MigrationItem, reportDir: string): Promise<MigrationItem>;
export declare function copyMigrationFileItem(item: MigrationItem, reportDir: string, opts?: {
    overwrite?: boolean;
}): Promise<MigrationItem>;
export declare function writeMigrationReport(result: MigrationApplyResult, opts?: {
    title?: string;
}): Promise<void>;
