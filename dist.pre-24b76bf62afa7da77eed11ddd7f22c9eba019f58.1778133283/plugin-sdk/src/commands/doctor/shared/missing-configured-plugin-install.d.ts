import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginPackageInstall } from "../../../plugins/manifest.js";
type DownloadableInstallCandidate = {
    pluginId: string;
    label: string;
    npmSpec?: string;
    clawhubSpec?: string;
    expectedIntegrity?: string;
    trustedSourceLinkedOfficialInstall?: boolean;
    defaultChoice?: PluginPackageInstall["defaultChoice"];
};
declare function collectConfiguredPluginIds(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): Set<string>;
declare function collectConfiguredChannelIds(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): Set<string>;
declare function collectDownloadableInstallCandidates(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    missingPluginIds: ReadonlySet<string>;
    configuredPluginIds?: ReadonlySet<string>;
    configuredChannelIds?: ReadonlySet<string>;
    configuredChannelOwnerPluginIds?: ReadonlyMap<string, ReadonlySet<string>>;
    blockedPluginIds?: ReadonlySet<string>;
}): DownloadableInstallCandidate[];
export declare function repairMissingConfiguredPluginInstalls(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    changes: string[];
    warnings: string[];
}>;
export declare function repairMissingPluginInstallsForIds(params: {
    cfg: OpenClawConfig;
    pluginIds: Iterable<string>;
    channelIds?: Iterable<string>;
    blockedPluginIds?: Iterable<string>;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    changes: string[];
    warnings: string[];
}>;
export declare const __testing: {
    collectConfiguredChannelIds: typeof collectConfiguredChannelIds;
    collectConfiguredPluginIds: typeof collectConfiguredPluginIds;
    collectDownloadableInstallCandidates: typeof collectDownloadableInstallCandidates;
};
export {};
