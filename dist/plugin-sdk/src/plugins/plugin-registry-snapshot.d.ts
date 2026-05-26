import { type InstalledPluginIndexStoreInspection, type InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store.js";
import { type InstalledPluginIndex, type InstalledPluginIndexRecord, type LoadInstalledPluginIndexParams, type RefreshInstalledPluginIndexParams } from "./installed-plugin-index.js";
export type PluginRegistrySnapshot = InstalledPluginIndex;
export type PluginRegistryRecord = InstalledPluginIndexRecord;
export type PluginRegistryInspection = InstalledPluginIndexStoreInspection;
export type PluginRegistrySnapshotSource = "provided" | "persisted" | "derived";
export type PluginRegistrySnapshotDiagnosticCode = "persisted-registry-disabled" | "persisted-registry-missing" | "persisted-registry-stale-policy" | "persisted-registry-stale-source";
export type PluginRegistrySnapshotDiagnostic = {
    level: "info" | "warn";
    code: PluginRegistrySnapshotDiagnosticCode;
    message: string;
};
export type PluginRegistrySnapshotResult = {
    snapshot: PluginRegistrySnapshot;
    source: PluginRegistrySnapshotSource;
    diagnostics: readonly PluginRegistrySnapshotDiagnostic[];
};
export declare const DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV = "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY";
export type LoadPluginRegistryParams = LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions & {
    index?: PluginRegistrySnapshot;
    preferPersisted?: boolean;
};
export type GetPluginRecordParams = LoadPluginRegistryParams & {
    pluginId: string;
};
export declare function loadPluginRegistrySnapshotWithMetadata(params?: LoadPluginRegistryParams): PluginRegistrySnapshotResult;
export declare function loadPluginRegistrySnapshot(params?: LoadPluginRegistryParams): PluginRegistrySnapshot;
export declare function listPluginRecords(params?: LoadPluginRegistryParams): readonly PluginRegistryRecord[];
export declare function getPluginRecord(params: GetPluginRecordParams): PluginRegistryRecord | undefined;
export declare function isPluginEnabled(params: GetPluginRecordParams): boolean;
export declare function inspectPluginRegistry(params?: LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions): Promise<PluginRegistryInspection>;
export declare function refreshPluginRegistry(params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions): Promise<PluginRegistrySnapshot>;
