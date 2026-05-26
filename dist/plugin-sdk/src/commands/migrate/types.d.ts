import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MigrationPlan } from "../../plugins/types.js";
export type MigrationConfigPatchMode = "return";
export type MigrateCommonOptions = {
    provider?: string;
    source?: string;
    includeSecrets?: boolean;
    overwrite?: boolean;
    skills?: string[];
    plugins?: string[];
    verifyPluginApps?: boolean;
    json?: boolean;
    suppressPlanLog?: boolean;
    configOverride?: OpenClawConfig;
    configPatchMode?: MigrationConfigPatchMode;
};
export type MigrateApplyOptions = MigrateCommonOptions & {
    yes?: boolean;
    noBackup?: boolean;
    force?: boolean;
    backupOutput?: string;
    preflightPlan?: MigrationPlan;
};
export type MigrateDefaultOptions = MigrateApplyOptions & {
    dryRun?: boolean;
};
