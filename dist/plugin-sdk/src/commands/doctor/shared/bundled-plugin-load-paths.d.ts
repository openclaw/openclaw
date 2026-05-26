import type { OpenClawConfig } from "../../../config/types.openclaw.js";
type BundledPluginLoadPathHit = {
    pluginId: string;
    fromPath: string;
    toPath: string;
    pathLabel: string;
};
export declare function scanBundledPluginLoadPathMigrations(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): BundledPluginLoadPathHit[];
export declare function collectBundledPluginLoadPathWarnings(params: {
    hits: BundledPluginLoadPathHit[];
    doctorFixCommand: string;
}): string[];
export declare function maybeRepairBundledPluginLoadPaths(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): {
    config: OpenClawConfig;
    changes: string[];
};
export {};
