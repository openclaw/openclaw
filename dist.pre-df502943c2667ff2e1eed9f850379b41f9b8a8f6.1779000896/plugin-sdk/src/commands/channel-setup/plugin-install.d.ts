import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { type OnboardingPluginInstallStatus } from "../onboarding-plugin-install.js";
type InstallResult = {
    cfg: OpenClawConfig;
    installed: boolean;
    pluginId?: string;
    status: OnboardingPluginInstallStatus;
};
export declare function ensureChannelSetupPluginInstalled(params: {
    cfg: OpenClawConfig;
    entry: ChannelPluginCatalogEntry;
    prompter: WizardPrompter;
    runtime: RuntimeEnv;
    workspaceDir?: string;
    promptInstall?: boolean;
    autoConfirmSingleSource?: boolean;
}): Promise<InstallResult>;
export declare function reloadChannelSetupPluginRegistry(params: {
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    workspaceDir?: string;
}): void;
export declare function reloadChannelSetupPluginRegistryForChannel(params: {
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    channel: string;
    pluginId?: string;
    workspaceDir?: string;
}): void;
export declare function loadChannelSetupPluginRegistrySnapshotForChannel(params: {
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    channel: string;
    pluginId?: string;
    workspaceDir?: string;
    forceSetupOnlyChannelPlugins?: boolean;
}): PluginRegistry;
export {};
