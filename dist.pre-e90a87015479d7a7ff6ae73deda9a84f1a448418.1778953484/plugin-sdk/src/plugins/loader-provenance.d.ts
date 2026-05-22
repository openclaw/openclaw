import type { PluginCandidate } from "./discovery.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import type { PluginLogger } from "./types.js";
type PathMatcher = {
    exact: Set<string>;
    dirs: string[];
};
type InstallTrackingRule = {
    trackedWithoutPaths: boolean;
    matcher: PathMatcher;
};
export type PluginProvenanceIndex = {
    loadPathMatcher: PathMatcher;
    installRules: Map<string, InstallTrackingRule>;
};
type OpenAllowlistWarningCache = {
    hasOpenAllowlistWarning(cacheKey: string): boolean;
    recordOpenAllowlistWarning(cacheKey: string): void;
};
export declare function buildProvenanceIndex(params: {
    normalizedLoadPaths: string[];
    env: NodeJS.ProcessEnv;
}): PluginProvenanceIndex;
export declare function compareDuplicateCandidateOrder(params: {
    left: PluginCandidate;
    right: PluginCandidate;
    manifestByRoot: Map<string, PluginManifestRecord>;
    provenance: PluginProvenanceIndex;
    env: NodeJS.ProcessEnv;
}): number;
export declare function warnWhenAllowlistIsOpen(params: {
    emitWarning: boolean;
    logger: PluginLogger;
    pluginsEnabled: boolean;
    allow: string[];
    warningCacheKey: string;
    warningCache: OpenAllowlistWarningCache;
    discoverablePlugins: Array<{
        id: string;
        source: string;
        origin: PluginRecord["origin"];
    }>;
}): void;
export declare function warnAboutUntrackedLoadedPlugins(params: {
    registry: PluginRegistry;
    provenance: PluginProvenanceIndex;
    allowlist: string[];
    emitWarning: boolean;
    logger: PluginLogger;
    env: NodeJS.ProcessEnv;
}): void;
export {};
