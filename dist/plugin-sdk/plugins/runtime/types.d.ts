import type { PluginRuntimeChannel } from "./types-channel.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";
export type { RuntimeLogger };
export type PluginRuntime = PluginRuntimeCore & {
    channel: PluginRuntimeChannel;
};
