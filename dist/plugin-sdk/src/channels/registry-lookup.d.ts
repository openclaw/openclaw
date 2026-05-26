import type { ActivePluginChannelRegistration } from "../plugins/channel-registry-state.types.js";
export type RegisteredChannelPluginEntry = ActivePluginChannelRegistration & {
    plugin: ActivePluginChannelRegistration["plugin"] & {
        id?: string | null;
        meta?: {
            aliases?: readonly string[];
            markdownCapable?: boolean;
        } | null;
    };
};
export declare function listRegisteredChannelPluginEntries(): RegisteredChannelPluginEntry[];
export declare function findRegisteredChannelPluginEntry(normalizedKey: string): RegisteredChannelPluginEntry | undefined;
export declare function findRegisteredChannelPluginEntryById(id: string): RegisteredChannelPluginEntry | undefined;
