import type { OpenClawConfig } from "../config/types.js";
export { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
export declare function requireRuntimeConfig(config: OpenClawConfig, context: string): OpenClawConfig;
export declare function resolvePluginConfigObject(config: OpenClawConfig | undefined, pluginId: string): Record<string, unknown> | undefined;
export declare function resolveLivePluginConfigObject(runtimeConfigLoader: (() => OpenClawConfig | undefined) | undefined, pluginId: string, startupPluginConfig?: Record<string, unknown>): Record<string, unknown> | undefined;
