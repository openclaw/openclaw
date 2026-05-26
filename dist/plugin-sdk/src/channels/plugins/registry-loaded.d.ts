import type { ActiveChannelPluginRuntimeShape, ActivePluginChannelRegistration } from "../../plugins/channel-registry-state.types.js";
export type LoadedChannelPlugin = ActiveChannelPluginRuntimeShape & {
    id: string;
    meta: NonNullable<ActiveChannelPluginRuntimeShape["meta"]>;
};
export type LoadedChannelPluginEntry = ActivePluginChannelRegistration & {
    plugin: LoadedChannelPlugin;
};
export declare function listLoadedChannelPlugins(): LoadedChannelPlugin[];
export declare function getLoadedChannelPluginById(id: string): LoadedChannelPlugin | undefined;
export declare function getLoadedChannelPluginEntryById(id: string): LoadedChannelPluginEntry | undefined;
