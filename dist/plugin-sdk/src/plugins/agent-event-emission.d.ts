import { type PluginAgentEventEmitParams, type PluginAgentEventEmitResult } from "./host-hooks.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
export declare function emitPluginAgentEvent(params: {
    pluginId: string;
    pluginName?: string;
    origin: PluginOrigin;
    event: PluginAgentEventEmitParams;
}): PluginAgentEventEmitResult;
