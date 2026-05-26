import { type PluginSdkResolutionPreference } from "./sdk-alias.js";
export type InstallOpenClawPluginSdkNativeResolverOptions = {
    modulePath?: string;
    pluginModulePath?: string;
    allowedParentRoots?: readonly string[];
    argv1?: string;
    moduleUrl?: string;
    pluginSdkResolution?: PluginSdkResolutionPreference;
};
export declare function installOpenClawPluginSdkNativeResolver(options?: InstallOpenClawPluginSdkNativeResolverOptions): string[];
export declare function resetOpenClawPluginSdkNativeResolverForTest(): void;
