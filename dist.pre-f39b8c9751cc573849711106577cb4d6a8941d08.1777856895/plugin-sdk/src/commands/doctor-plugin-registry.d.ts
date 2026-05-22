import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstalledPluginIndexRecordStoreOptions } from "../plugins/installed-plugin-index-records.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { type PluginRegistryInstallMigrationParams } from "./doctor/shared/plugin-registry-migration.js";
type PluginRegistryDoctorRepairParams = Omit<PluginRegistryInstallMigrationParams, "config"> & InstalledPluginIndexRecordStoreOptions & {
    config: OpenClawConfig;
    prompter: Pick<DoctorPrompter, "shouldRepair">;
};
export declare function maybeRepairPluginRegistryState(params: PluginRegistryDoctorRepairParams): Promise<OpenClawConfig>;
export {};
