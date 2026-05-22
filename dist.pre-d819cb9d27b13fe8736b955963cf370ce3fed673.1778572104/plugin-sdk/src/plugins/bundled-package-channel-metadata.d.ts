import type { PluginPackageChannel } from "./manifest.js";
export declare function listBundledPackageChannelMetadata(): readonly PluginPackageChannel[];
export declare function findBundledPackageChannelMetadata(channelId: string): PluginPackageChannel | undefined;
