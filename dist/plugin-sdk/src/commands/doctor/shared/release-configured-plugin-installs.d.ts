import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export declare const CONFIGURED_PLUGIN_INSTALL_RELEASE_VERSION = "2026.5.2-beta.1";
type ReleaseConfiguredPluginIds = {
    pluginIds: string[];
    channelIds: string[];
};
export declare function shouldRunConfiguredPluginInstallReleaseStep(params: {
    currentVersion?: string | null;
    touchedVersion?: string | null;
    releaseVersion?: string;
}): boolean;
export declare function collectReleaseConfiguredPluginIds(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): ReleaseConfiguredPluginIds;
export declare function maybeRunConfiguredPluginInstallReleaseStep(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    touchedVersion?: string | null;
    currentVersion?: string | null;
}): Promise<{
    changes: string[];
    warnings: string[];
    completed: boolean;
    touchedConfig: boolean;
}>;
export {};
