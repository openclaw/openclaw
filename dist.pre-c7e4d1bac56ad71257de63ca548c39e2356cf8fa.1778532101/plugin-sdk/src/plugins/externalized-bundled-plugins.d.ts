export type ExternalizedBundledPluginPreferredSource = "npm" | "clawhub";
export type ExternalizedBundledPluginBridge = {
    /** Plugin id used while the plugin was bundled in core. */
    bundledPluginId: string;
    /** Plugin id declared by the external package. Defaults to bundledPluginId. */
    pluginId?: string;
    /** Preferred external source when migrating the bundled plugin out. Defaults to npm. */
    preferredSource?: ExternalizedBundledPluginPreferredSource;
    /** npm spec OpenClaw can install when migrating the bundled plugin out. */
    npmSpec?: string;
    /** ClawHub spec OpenClaw can install when migrating the bundled plugin out. */
    clawhubSpec?: string;
    /** Optional ClawHub base URL for non-default registries. */
    clawhubUrl?: string;
    /** Bundled directory name, when it differs from bundledPluginId. */
    bundledDirName?: string;
    /** Previous bundled manifest default enablement from the persisted registry. */
    enabledByDefault?: boolean;
    /** Legacy ids that should be treated as this plugin during enablement checks. */
    legacyPluginIds?: readonly string[];
    /** Channel ids that imply this plugin is enabled when configured. */
    channelIds?: readonly string[];
    /** Plugin ids this external package supersedes for channel selection. */
    preferOver?: readonly string[];
};
export declare function getExternalizedBundledPluginPreferredSource(bridge: ExternalizedBundledPluginBridge): ExternalizedBundledPluginPreferredSource;
export declare function getExternalizedBundledPluginNpmSpec(bridge: ExternalizedBundledPluginBridge): string;
export declare function getExternalizedBundledPluginClawHubSpec(bridge: ExternalizedBundledPluginBridge): string;
export declare function getExternalizedBundledPluginTargetId(bridge: ExternalizedBundledPluginBridge): string;
export declare function getExternalizedBundledPluginLookupIds(bridge: ExternalizedBundledPluginBridge): readonly string[];
export declare function getExternalizedBundledPluginLegacyPathSuffix(bridge: ExternalizedBundledPluginBridge): string;
