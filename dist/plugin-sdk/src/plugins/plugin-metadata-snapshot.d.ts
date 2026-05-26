import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { type PluginManifestRecord } from "./manifest-registry.js";
import type { LoadPluginMetadataSnapshotParams, PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
export type { LoadPluginMetadataSnapshotParams, PluginMetadataManifestView, PluginMetadataRegistryView, PluginMetadataSnapshot, PluginMetadataSnapshotMetrics, PluginMetadataSnapshotOwnerMaps, PluginMetadataSnapshotRegistryDiagnostic, } from "./plugin-metadata-snapshot.types.js";
export declare function isPluginMetadataSnapshotCompatible(params: {
    snapshot: Pick<PluginMetadataSnapshot, "configFingerprint" | "index" | "policyHash" | "workspaceDir">;
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    index?: InstalledPluginIndex;
}): boolean;
export declare function listPluginOriginsFromMetadataSnapshot(snapshot: Pick<PluginMetadataSnapshot, "plugins">): ReadonlyMap<string, PluginManifestRecord["origin"]>;
export declare function loadPluginMetadataSnapshot(params: LoadPluginMetadataSnapshotParams): PluginMetadataSnapshot;
