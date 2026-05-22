export type PluginDefaultEnablement = {
    enabledByDefault?: boolean;
    enabledByDefaultOnPlatforms?: readonly string[];
};
export declare function isPluginEnabledByDefaultForPlatform(plugin: PluginDefaultEnablement, platform?: NodeJS.Platform): boolean;
