import { type ChannelId } from "../channels/plugins/index.js";
export type ChannelKind = ChannelId;
export type GatewayReloadPlan = {
    changedPaths: string[];
    restartGateway: boolean;
    restartReasons: string[];
    hotReasons: string[];
    reloadHooks: boolean;
    restartGmailWatcher: boolean;
    restartCron: boolean;
    restartHeartbeat: boolean;
    restartHealthMonitor: boolean;
    reloadPlugins: boolean;
    restartChannels: Set<ChannelKind>;
    disposeMcpRuntimes: boolean;
    noopPaths: string[];
};
type ReloadRule = {
    prefix: string;
    kind: "restart" | "hot" | "none";
    actions?: ReloadAction[];
};
export type ConfigReloadMetadata = {
    kind: ReloadRule["kind"];
};
type ReloadAction = "reload-hooks" | "restart-gmail-watcher" | "restart-cron" | "restart-heartbeat" | "restart-health-monitor" | "reload-plugins" | "dispose-mcp-runtimes" | `restart-channel:${ChannelId}`;
type GatewayReloadPlanOptions = {
    noopPaths?: Iterable<string>;
    forceChangedPaths?: Iterable<string>;
};
export declare function resolveConfigReloadMetadata(path: string): ConfigReloadMetadata;
export declare function listPluginInstallTimestampMetadataPaths(prevConfig: unknown, nextConfig: unknown): string[];
export declare function listPluginInstallWholeRecordPaths(prevConfig: unknown, nextConfig: unknown): string[];
export declare function buildGatewayReloadPlan(changedPaths: string[], options?: GatewayReloadPlanOptions): GatewayReloadPlan;
export {};
