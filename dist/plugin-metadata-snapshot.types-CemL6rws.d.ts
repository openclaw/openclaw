import { t as InstalledPluginIndex } from "./installed-plugin-index-types-BNeq3o_Y.js";
import { r as PluginDiagnostic } from "./manifest-types-C_IWdo1j.js";
import { n as PluginManifestRegistry, t as PluginManifestRecord } from "./manifest-registry-CMekBFSM.js";

//#region src/plugins/plugin-registry-snapshot.types.d.ts
type PluginRegistrySnapshotSource = "provided" | "persisted" | "derived";
//#endregion
//#region src/plugins/plugin-metadata-snapshot.types.d.ts
type PluginMetadataSnapshotOwnerMaps = {
  channels: ReadonlyMap<string, readonly string[]>;
  channelConfigs: ReadonlyMap<string, readonly string[]>;
  providers: ReadonlyMap<string, readonly string[]>;
  modelCatalogProviders: ReadonlyMap<string, readonly string[]>;
  cliBackends: ReadonlyMap<string, readonly string[]>;
  setupProviders: ReadonlyMap<string, readonly string[]>;
  commandAliases: ReadonlyMap<string, readonly string[]>;
  contracts: ReadonlyMap<string, readonly string[]>;
};
type PluginMetadataSnapshotMetrics = {
  registrySnapshotMs: number;
  manifestRegistryMs: number;
  ownerMapsMs: number;
  totalMs: number;
  indexPluginCount: number;
  manifestPluginCount: number;
};
type PluginMetadataSnapshotRegistryDiagnostic = {
  level: "info" | "warn";
  code: "persisted-registry-disabled" | "persisted-registry-missing" | "persisted-registry-stale-policy" | "persisted-registry-stale-source";
  message: string;
};
type PluginMetadataSnapshot = {
  policyHash: string;
  configFingerprint?: string;
  registrySource?: PluginRegistrySnapshotSource;
  workspaceDir?: string;
  index: InstalledPluginIndex;
  registryDiagnostics: readonly PluginMetadataSnapshotRegistryDiagnostic[];
  manifestRegistry: PluginManifestRegistry;
  plugins: readonly PluginManifestRecord[];
  diagnostics: readonly PluginDiagnostic[];
  byPluginId: ReadonlyMap<string, PluginManifestRecord>;
  normalizePluginId: (pluginId: string) => string;
  owners: PluginMetadataSnapshotOwnerMaps;
  metrics: PluginMetadataSnapshotMetrics;
};
type PluginMetadataRegistryView = Pick<PluginMetadataSnapshot, "index" | "manifestRegistry">;
//#endregion
export { PluginMetadataSnapshot as n, PluginMetadataRegistryView as t };