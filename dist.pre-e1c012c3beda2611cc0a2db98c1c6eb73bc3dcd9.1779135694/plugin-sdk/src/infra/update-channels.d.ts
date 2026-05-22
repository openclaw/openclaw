export type UpdateChannel = "stable" | "beta" | "dev";
export type UpdateChannelSource = "config" | "git-tag" | "git-branch" | "installed-version" | "default";
export declare const DEFAULT_PACKAGE_CHANNEL: UpdateChannel;
export declare const DEFAULT_GIT_CHANNEL: UpdateChannel;
export declare const DEV_BRANCH = "main";
export declare function normalizeUpdateChannel(value?: string | null): UpdateChannel | null;
export declare function channelToNpmTag(channel: UpdateChannel): string;
export declare function isBetaTag(tag: string): boolean;
export declare function isStableTag(tag: string): boolean;
export declare function resolveRegistryUpdateChannel(params: {
    configChannel?: UpdateChannel | null;
    currentVersion?: string | null;
}): UpdateChannel;
export declare function resolveEffectiveUpdateChannel(params: {
    configChannel?: UpdateChannel | null;
    currentVersion?: string | null;
    installKind: "git" | "package" | "unknown";
    git?: {
        tag?: string | null;
        branch?: string | null;
    };
}): {
    channel: UpdateChannel;
    source: UpdateChannelSource;
};
export declare function formatUpdateChannelLabel(params: {
    channel: UpdateChannel;
    source: UpdateChannelSource;
    gitTag?: string | null;
    gitBranch?: string | null;
}): string;
export declare function resolveUpdateChannelDisplay(params: {
    configChannel?: UpdateChannel | null;
    currentVersion?: string | null;
    installKind: "git" | "package" | "unknown";
    gitTag?: string | null;
    gitBranch?: string | null;
}): {
    channel: UpdateChannel;
    source: UpdateChannelSource;
    label: string;
};
