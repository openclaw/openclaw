import type { OpenClawConfig } from "../config/config.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { type PluginRegistry } from "./registry.js";
import { type CreatePluginRuntimeOptions } from "./runtime/index.js";
import type { PluginLogger } from "./types.js";
export type PluginLoadResult = PluginRegistry;
export type PluginLoadOptions = {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    logger?: PluginLogger;
    coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
    runtimeOptions?: CreatePluginRuntimeOptions;
    cache?: boolean;
    mode?: "full" | "validate";
};
export declare function clearPluginLoaderCache(): void;
type PluginSdkAliasCandidateKind = "dist" | "src";
declare function resolvePluginSdkAliasCandidateOrder(params: {
    modulePath: string;
    isProduction: boolean;
}): PluginSdkAliasCandidateKind[];
declare function listPluginSdkAliasCandidates(params: {
    srcFile: string;
    distFile: string;
    modulePath: string;
}): string[];
declare function listPluginSdkExportedSubpaths(params?: {
    modulePath?: string;
}): string[];
export declare const __testing: {
    listPluginSdkAliasCandidates: typeof listPluginSdkAliasCandidates;
    listPluginSdkExportedSubpaths: typeof listPluginSdkExportedSubpaths;
    resolvePluginSdkAliasCandidateOrder: typeof resolvePluginSdkAliasCandidateOrder;
    resolvePluginSdkAliasFile: (params: {
        srcFile: string;
        distFile: string;
        modulePath?: string;
    }) => string | null;
    maxPluginRegistryCacheEntries: number;
};
export declare function loadOpenClawPlugins(options?: PluginLoadOptions): PluginRegistry;
export {};
