import { type PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { OpenClawConfig } from "./config.js";
export type PluginAutoEnableResult = {
    config: OpenClawConfig;
    changes: string[];
};
export declare function isChannelConfigured(cfg: OpenClawConfig, channelId: string, env?: NodeJS.ProcessEnv): boolean;
export declare function applyPluginAutoEnable(params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    /** Pre-loaded manifest registry. When omitted, the registry is loaded from
     *  the installed plugins on disk. Pass an explicit registry in tests to
     *  avoid filesystem access and control what plugins are "installed". */
    manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult;
