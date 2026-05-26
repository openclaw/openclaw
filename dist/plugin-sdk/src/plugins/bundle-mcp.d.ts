import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginBundleFormat } from "./manifest-types.js";
export type BundleMcpServerConfig = Record<string, unknown>;
export type BundleMcpConfig = {
    mcpServers: Record<string, BundleMcpServerConfig>;
};
export type BundleMcpDiagnostic = {
    pluginId: string;
    message: string;
};
export type EnabledBundleMcpConfigResult = {
    config: BundleMcpConfig;
    diagnostics: BundleMcpDiagnostic[];
};
export type BundleMcpRuntimeSupport = {
    hasSupportedStdioServer: boolean;
    supportedServerNames: string[];
    unsupportedServerNames: string[];
    diagnostics: string[];
};
export declare function extractMcpServerMap(raw: unknown): Record<string, BundleMcpServerConfig>;
export declare function inspectBundleMcpRuntimeSupport(params: {
    pluginId: string;
    rootDir: string;
    bundleFormat: PluginBundleFormat;
}): BundleMcpRuntimeSupport;
export declare function loadEnabledBundleMcpConfig(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
}): EnabledBundleMcpConfigResult;
