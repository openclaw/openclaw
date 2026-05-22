import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type GatewayStartupPluginPlan } from "./channel-plugin-ids.js";
import { type PluginMetadataSnapshot, type PluginMetadataSnapshotOwnerMaps } from "./plugin-metadata-snapshot.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";
export type PluginLookUpTableOwnerMaps = PluginMetadataSnapshotOwnerMaps;
export type PluginLookUpTableStartupPlan = GatewayStartupPluginPlan;
export type PluginLookUpTableMetrics = {
    registrySnapshotMs: number;
    manifestRegistryMs: number;
    startupPlanMs: number;
    ownerMapsMs: number;
    totalMs: number;
    indexPluginCount: number;
    manifestPluginCount: number;
    startupPluginCount: number;
    deferredChannelPluginCount: number;
};
export type PluginLookUpTable = PluginMetadataSnapshot & {
    key: string;
    startup: PluginLookUpTableStartupPlan;
    metrics: PluginMetadataSnapshot["metrics"] & Pick<PluginLookUpTableMetrics, "startupPlanMs" | "startupPluginCount" | "deferredChannelPluginCount">;
};
export type LoadPluginLookUpTableParams = {
    config: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    workspaceDir?: string;
    env: NodeJS.ProcessEnv;
    index?: PluginRegistrySnapshot;
    metadataSnapshot?: PluginMetadataSnapshot;
};
export declare function loadPluginLookUpTable(params: LoadPluginLookUpTableParams): PluginLookUpTable;
