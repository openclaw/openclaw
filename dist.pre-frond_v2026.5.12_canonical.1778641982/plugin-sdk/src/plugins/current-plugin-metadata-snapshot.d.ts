import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ResolvePluginControlPlaneContextParams } from "./plugin-control-plane-context.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
export declare function resolvePluginMetadataControlPlaneFingerprint(config?: OpenClawConfig, options?: Omit<ResolvePluginControlPlaneContextParams, "config">): string;
export declare function setCurrentPluginMetadataSnapshot(snapshot: PluginMetadataSnapshot | undefined, options?: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
}): void;
export declare function clearCurrentPluginMetadataSnapshot(): void;
export declare function getCurrentPluginMetadataSnapshot(params?: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    allowWorkspaceScopedSnapshot?: boolean;
}): PluginMetadataSnapshot | undefined;
