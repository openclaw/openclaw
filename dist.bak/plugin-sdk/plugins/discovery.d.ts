import { type OpenClawPackageManifest } from "./manifest.js";
import type { PluginDiagnostic, PluginOrigin } from "./types.js";
export type PluginCandidate = {
    idHint: string;
    source: string;
    rootDir: string;
    origin: PluginOrigin;
    workspaceDir?: string;
    packageName?: string;
    packageVersion?: string;
    packageDescription?: string;
    packageDir?: string;
    packageManifest?: OpenClawPackageManifest;
};
export type PluginDiscoveryResult = {
    candidates: PluginCandidate[];
    diagnostics: PluginDiagnostic[];
};
export type CandidateBlockReason = "source_escapes_root" | "path_stat_failed" | "path_world_writable" | "path_suspicious_ownership";
export declare function discoverOpenClawPlugins(params: {
    workspaceDir?: string;
    extraPaths?: string[];
    ownershipUid?: number | null;
}): PluginDiscoveryResult;
