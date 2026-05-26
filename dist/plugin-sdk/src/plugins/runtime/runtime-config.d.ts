import type { PluginRuntime } from "./types.js";
/** @internal Test-only reset for the runtime config compatibility warning cache. */
export declare function resetRuntimeConfigDeprecationWarningStateForTest(): void;
export declare function createPluginScopedRuntimeConfig(config: PluginRuntime["config"], runWithPluginScope: <T>(run: () => T) => T): PluginRuntime["config"];
export declare function createRuntimeConfig(): PluginRuntime["config"];
