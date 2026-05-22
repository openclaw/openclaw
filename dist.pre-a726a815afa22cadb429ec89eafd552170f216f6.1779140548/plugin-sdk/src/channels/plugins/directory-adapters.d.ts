import type { ChannelDirectoryAdapter } from "./types.adapters.js";
export declare const nullChannelDirectorySelf: NonNullable<ChannelDirectoryAdapter["self"]>;
export declare const emptyChannelDirectoryList: NonNullable<ChannelDirectoryAdapter["listPeers"]>;
/** Build a channel directory adapter with a null self resolver by default. */
export declare function createChannelDirectoryAdapter(params?: Omit<ChannelDirectoryAdapter, "self"> & {
    self?: ChannelDirectoryAdapter["self"];
}): ChannelDirectoryAdapter;
/** Build the common empty directory surface for channels without directory support. */
export declare function createEmptyChannelDirectoryAdapter(): ChannelDirectoryAdapter;
