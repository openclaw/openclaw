import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
export type UninstallActions = {
    entry: boolean;
    install: boolean;
    allowlist: boolean;
    denylist: boolean;
    loadPath: boolean;
    memorySlot: boolean;
    contextEngineSlot: boolean;
    channelConfig: boolean;
    directory: boolean;
};
export declare const UNINSTALL_ACTION_LABELS: {
    entry: string;
    install: string;
    allowlist: string;
    denylist: string;
    loadPath: string;
    memorySlot: string;
    contextEngineSlot: string;
    channelConfig: string;
    directory: string;
};
export declare function createEmptyUninstallActions(overrides?: Partial<UninstallActions>): UninstallActions;
export declare function formatUninstallActionLabels(actions: UninstallActions): string[];
export declare function formatUninstallSlotResetPreview(slotKey: "memory" | "contextEngine"): string;
export type UninstallPluginResult = {
    ok: true;
    config: OpenClawConfig;
    pluginId: string;
    actions: UninstallActions;
    warnings: string[];
} | {
    ok: false;
    error: string;
};
export type PluginUninstallDirectoryRemoval = {
    target: string;
    cleanup?: {
        kind: "npm";
        npmRoot: string;
        packageName: string;
    } | {
        kind: "git";
        parentDir: string;
    };
};
export type PluginUninstallPlanResult = {
    ok: true;
    config: OpenClawConfig;
    pluginId: string;
    actions: UninstallActions;
    directoryRemoval: PluginUninstallDirectoryRemoval | null;
} | {
    ok: false;
    error: string;
};
export declare function resolveUninstallDirectoryTarget(params: {
    pluginId: string;
    hasInstall: boolean;
    installRecord?: PluginInstallRecord;
    extensionsDir?: string;
}): string | null;
/**
 * Resolve the channel config keys owned by a plugin during uninstall.
 * - `channelIds === undefined`: fall back to the plugin id for backward compatibility.
 * - `channelIds === []`: explicit "owns no channels" signal; remove nothing.
 */
export declare function resolveUninstallChannelConfigKeys(pluginId: string, opts?: {
    channelIds?: string[];
}): string[];
/**
 * Remove plugin references from config (pure config mutation).
 * Returns a new config with the plugin removed from entries, installs, allow, load.paths, slots,
 * and owned channel config.
 */
export declare function removePluginFromConfig(cfg: OpenClawConfig, pluginId: string, opts?: {
    channelIds?: string[];
}): {
    config: OpenClawConfig;
    actions: Omit<UninstallActions, "directory">;
};
export type UninstallPluginParams = {
    config: OpenClawConfig;
    pluginId: string;
    channelIds?: string[];
    deleteFiles?: boolean;
    extensionsDir?: string;
};
/**
 * Plan a plugin uninstall by removing it from config and resolving a safe file-removal target.
 * Linked path plugins never have their source directory deleted. Copied path installs still remove
 * their managed install directory.
 */
export declare function planPluginUninstall(params: UninstallPluginParams): PluginUninstallPlanResult;
export declare function applyPluginUninstallDirectoryRemoval(removal: PluginUninstallDirectoryRemoval | null): Promise<{
    directoryRemoved: boolean;
    warnings: string[];
}>;
export declare function uninstallPlugin(params: UninstallPluginParams): Promise<UninstallPluginResult>;
