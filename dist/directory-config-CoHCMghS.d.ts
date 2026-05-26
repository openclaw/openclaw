import { u as ChannelDirectoryEntry } from "./types.core-1gFCH89g.js";
import { t as DirectoryConfigParams } from "./directory-types-DWCzXJFS.js";
//#region extensions/slack/src/directory-config.d.ts
declare const listSlackDirectoryPeersFromConfig: (configParams: DirectoryConfigParams) => Promise<ChannelDirectoryEntry[]>;
declare const listSlackDirectoryGroupsFromConfig: (configParams: DirectoryConfigParams) => Promise<ChannelDirectoryEntry[]>;
//#endregion
export { listSlackDirectoryPeersFromConfig as n, listSlackDirectoryGroupsFromConfig as t };