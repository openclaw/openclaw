import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import type { PluginRegistry } from "../registry.js";
import type { PluginLogger } from "../types.js";
import { type PluginRuntimeLoadContext } from "./load-context.js";
export declare function loadPluginMetadataRegistrySnapshot(options?: {
    config?: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    logger?: PluginLogger;
    workspaceDir?: string;
    onlyPluginIds?: string[];
    loadModules?: boolean;
    manifestRegistry?: PluginManifestRegistry;
    runtimeContext?: PluginRuntimeLoadContext;
}): PluginRegistry;
