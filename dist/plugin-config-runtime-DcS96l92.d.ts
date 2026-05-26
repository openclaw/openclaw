import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region src/plugin-sdk/plugin-config-runtime.d.ts
declare function requireRuntimeConfig(config: OpenClawConfig, context: string): OpenClawConfig;
declare function resolvePluginConfigObject(config: OpenClawConfig | undefined, pluginId: string): Record<string, unknown> | undefined;
declare function resolveLivePluginConfigObject(runtimeConfigLoader: (() => OpenClawConfig | undefined) | undefined, pluginId: string, startupPluginConfig?: Record<string, unknown>): Record<string, unknown> | undefined;
//#endregion
export { resolveLivePluginConfigObject as n, resolvePluginConfigObject as r, requireRuntimeConfig as t };