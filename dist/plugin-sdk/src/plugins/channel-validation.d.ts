import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { PluginDiagnostic } from "./manifest-types.js";
export declare function normalizeRegisteredChannelPlugin(params: {
    pluginId: string;
    source: string;
    plugin: ChannelPlugin;
    pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ChannelPlugin | null;
