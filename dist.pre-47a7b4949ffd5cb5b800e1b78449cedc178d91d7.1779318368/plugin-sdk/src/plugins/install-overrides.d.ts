export declare const PLUGIN_INSTALL_OVERRIDES_ENV = "OPENCLAW_PLUGIN_INSTALL_OVERRIDES";
export declare const ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV = "OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES";
export type PluginInstallOverride = {
    kind: "npm";
    spec: string;
} | {
    kind: "npm-pack";
    archivePath: string;
};
export declare function resolvePluginInstallOverride(params: {
    pluginId: string;
    env?: NodeJS.ProcessEnv;
}): PluginInstallOverride | null;
