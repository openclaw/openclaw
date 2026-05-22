import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { PluginBundleFormat, PluginDiagnostic, PluginFormat } from "./manifest-types.js";
import { type PluginManifest, type OpenClawPackageManifest } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { type PluginDependencySpecMap } from "./status-dependencies.js";
export type PluginCandidate = {
    idHint: string;
    source: string;
    setupSource?: string;
    rootDir: string;
    origin: PluginOrigin;
    format?: PluginFormat;
    bundleFormat?: PluginBundleFormat;
    workspaceDir?: string;
    packageName?: string;
    packageVersion?: string;
    packageDescription?: string;
    packageDir?: string;
    packageManifest?: OpenClawPackageManifest;
    packageDependencies?: PluginDependencySpecMap;
    packageOptionalDependencies?: PluginDependencySpecMap;
    bundledManifest?: PluginManifest;
    bundledManifestPath?: string;
};
export type PluginDiscoveryResult = {
    candidates: PluginCandidate[];
    diagnostics: PluginDiagnostic[];
};
export type CandidateBlockReason = "source_escapes_root" | "path_stat_failed" | "path_world_writable" | "path_suspicious_ownership";
export declare function discoverOpenClawPlugins(params: {
    workspaceDir?: string;
    extraPaths?: string[];
    installRecords?: Record<string, PluginInstallRecord>;
    ownershipUid?: number | null;
    env?: NodeJS.ProcessEnv;
}): PluginDiscoveryResult;
