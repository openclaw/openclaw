import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";
export declare function listChannelPlugins(): ChannelPlugin[];
export declare function getLoadedChannelPlugin(id: ChannelId): ChannelPlugin | undefined;
export declare function getLoadedChannelPluginOrigin(id: ChannelId): string | undefined;
export declare function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined;
export declare function normalizeChannelId(raw?: string | null): ChannelId | null;
