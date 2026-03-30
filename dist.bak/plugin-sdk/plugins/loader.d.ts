import type { OpenClawConfig } from "../config/config.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { type PluginRegistry } from "./registry.js";
import type { PluginLogger } from "./types.js";
export type PluginLoadResult = PluginRegistry;
export type PluginLoadOptions = {
    config?: OpenClawConfig;
    workspaceDir?: string;
    logger?: PluginLogger;
    coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
    cache?: boolean;
    mode?: "full" | "validate";
};
export declare const __testing: {
    resolvePluginSdkAliasFile: (params: {
        srcFile: string;
        distFile: string;
        modulePath?: string;
    }) => string | null;
};
export declare function loadOpenClawPlugins(options?: PluginLoadOptions): PluginRegistry;
