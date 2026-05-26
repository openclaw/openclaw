import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginLoadOptions } from "../loader.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import type { PluginLogger } from "../types.js";
export type PluginRuntimeLoadContext = {
    rawConfig: OpenClawConfig;
    config: OpenClawConfig;
    activationSourceConfig: OpenClawConfig;
    autoEnabledReasons: Readonly<Record<string, string[]>>;
    workspaceDir: string | undefined;
    env: NodeJS.ProcessEnv;
    logger: PluginLogger;
};
export type PluginRuntimeResolvedLoadValues = Pick<PluginLoadOptions, "config" | "activationSourceConfig" | "autoEnabledReasons" | "workspaceDir" | "env" | "logger">;
export type PluginRuntimeLoadContextOptions = {
    config?: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    logger?: PluginLogger;
    manifestRegistry?: PluginManifestRegistry;
};
export declare function createPluginRuntimeLoaderLogger(): PluginLogger;
export declare function resolvePluginRuntimeLoadContext(options?: PluginRuntimeLoadContextOptions): PluginRuntimeLoadContext;
export declare function buildPluginRuntimeLoadOptions(context: PluginRuntimeLoadContext, overrides?: Partial<PluginLoadOptions>): PluginLoadOptions;
export declare function buildPluginRuntimeLoadOptionsFromValues(values: PluginRuntimeResolvedLoadValues, overrides?: Partial<PluginLoadOptions>): PluginLoadOptions;
