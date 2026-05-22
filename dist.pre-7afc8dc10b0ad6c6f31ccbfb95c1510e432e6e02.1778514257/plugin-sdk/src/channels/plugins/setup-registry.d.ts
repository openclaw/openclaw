import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";
export declare function listChannelSetupPlugins(): ChannelPlugin[];
export declare function listActiveChannelSetupPlugins(): ChannelPlugin[];
export declare function getChannelSetupPlugin(id: ChannelId): ChannelPlugin | undefined;
