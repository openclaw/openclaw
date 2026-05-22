import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { type PluginSourceRoots } from "./roots.js";
export type PluginDiscoveryContext = {
    roots: PluginSourceRoots;
    loadPaths: readonly string[];
};
export type PluginControlPlaneContext = {
    discovery: PluginDiscoveryContext;
    policyFingerprint: string;
    inventoryFingerprint?: string;
    activationFingerprint?: string;
};
export type ResolvePluginDiscoveryContextParams = {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    loadPaths?: readonly string[];
};
export type ResolvePluginControlPlaneContextParams = ResolvePluginDiscoveryContextParams & {
    activationFingerprint?: string;
    index?: InstalledPluginIndex;
    inventoryFingerprint?: string;
    policyHash?: string;
};
export declare function resolvePluginDiscoveryContext(params?: ResolvePluginDiscoveryContextParams): PluginDiscoveryContext;
export declare function resolvePluginDiscoveryFingerprint(params?: ResolvePluginDiscoveryContextParams): string;
export declare function fingerprintPluginDiscoveryContext(context: PluginDiscoveryContext): string;
export declare function resolvePluginControlPlaneContext(params?: ResolvePluginControlPlaneContextParams): PluginControlPlaneContext;
export declare function resolvePluginControlPlaneFingerprint(params?: ResolvePluginControlPlaneContextParams): string;
