import { i as OpenClawConfig } from "../../../types.openclaw-BLF4DJTX.js";
import { r as LoadInstalledPluginIndexParams, t as InstalledPluginIndex } from "../../../installed-plugin-index-types-BNeq3o_Y.js";
import { n as InstalledPluginIndexStoreOptions, t as InstalledPluginIndexStoreInspection } from "../../../installed-plugin-index-store-DOWcYfTI.js";

//#region src/commands/doctor/shared/plugin-registry-migration.d.ts
declare const DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION";
declare const FORCE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_FORCE_PLUGIN_REGISTRY_MIGRATION";
type PluginRegistryInstallMigrationPreflightAction = "disabled" | "skip-existing" | "migrate";
type PluginRegistryInstallMigrationPreflight = {
  action: PluginRegistryInstallMigrationPreflightAction;
  filePath: string;
  force: boolean;
  deprecationWarnings: readonly string[];
};
type PluginRegistryInstallMigrationResult = {
  status: "disabled" | "skip-existing" | "dry-run";
  migrated: false;
  preflight: PluginRegistryInstallMigrationPreflight;
} | {
  status: "migrated";
  migrated: true;
  preflight: PluginRegistryInstallMigrationPreflight;
  inspection: InstalledPluginIndexStoreInspection;
  current: InstalledPluginIndex;
};
type PluginRegistryInstallMigrationParams = LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions & {
  dryRun?: boolean;
  existsSync?: (path: string) => boolean;
  readConfig?: () => Promise<OpenClawConfig> | OpenClawConfig;
};
declare function preflightPluginRegistryInstallMigration(params?: PluginRegistryInstallMigrationParams): PluginRegistryInstallMigrationPreflight;
declare function migratePluginRegistryForInstall(params?: PluginRegistryInstallMigrationParams): Promise<PluginRegistryInstallMigrationResult>;
//#endregion
export { DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV, FORCE_PLUGIN_REGISTRY_MIGRATION_ENV, PluginRegistryInstallMigrationParams, PluginRegistryInstallMigrationPreflight, PluginRegistryInstallMigrationPreflightAction, PluginRegistryInstallMigrationResult, migratePluginRegistryForInstall, preflightPluginRegistryInstallMigration };