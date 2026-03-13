import type { PluginRuntime } from "./types.js";
export type CreatePluginRuntimeOptions = {
    subagent?: PluginRuntime["subagent"];
};
export declare function createPluginRuntime(_options?: CreatePluginRuntimeOptions): PluginRuntime;
export type { PluginRuntime } from "./types.js";
