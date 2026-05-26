import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginBundleFormat } from "./manifest-types.js";
export type BundleLspServerConfig = Record<string, unknown>;
export type BundleLspConfig = {
    lspServers: Record<string, BundleLspServerConfig>;
};
export type BundleLspRuntimeSupport = {
    hasStdioServer: boolean;
    supportedServerNames: string[];
    unsupportedServerNames: string[];
    diagnostics: string[];
};
export declare function inspectBundleLspRuntimeSupport(params: {
    pluginId: string;
    rootDir: string;
    bundleFormat: PluginBundleFormat;
}): BundleLspRuntimeSupport;
export declare function loadEnabledBundleLspConfig(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
}): {
    config: BundleLspConfig;
    diagnostics: Array<{
        pluginId: string;
        message: string;
    }>;
};
