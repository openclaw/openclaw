import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";
export declare function listBootstrapChannelPluginIds(): readonly string[];
export declare function iterateBootstrapChannelPlugins(): IterableIterator<ChannelPlugin>;
export declare function getBootstrapChannelPlugin(id: ChannelId): ChannelPlugin | undefined;
export declare function getBootstrapChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined;
