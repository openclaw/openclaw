import type { ChannelDirectoryEntry, DirectoryConfigParams } from "openclaw/plugin-sdk/directory-runtime";
export declare function listDiscordDirectoryGroupsLive(params: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]>;
export declare function listDiscordDirectoryPeersLive(params: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]>;
