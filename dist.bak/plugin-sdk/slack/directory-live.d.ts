import type { DirectoryConfigParams } from "../channels/plugins/directory-config.js";
import type { ChannelDirectoryEntry } from "../channels/plugins/types.js";
export declare function listSlackDirectoryPeersLive(params: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]>;
export declare function listSlackDirectoryGroupsLive(params: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]>;
