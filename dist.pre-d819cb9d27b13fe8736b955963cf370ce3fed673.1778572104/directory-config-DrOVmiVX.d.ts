import { u as ChannelDirectoryEntry } from "./types.core-BoZgMdCh.js";
import { t as DirectoryConfigParams } from "./directory-types-BHEXCgby.js";
//#region extensions/slack/src/directory-config.d.ts
declare const listSlackDirectoryPeersFromConfig: (configParams: DirectoryConfigParams) => Promise<ChannelDirectoryEntry[]>;
declare const listSlackDirectoryGroupsFromConfig: (configParams: DirectoryConfigParams) => Promise<ChannelDirectoryEntry[]>;
//#endregion
export { listSlackDirectoryPeersFromConfig as n, listSlackDirectoryGroupsFromConfig as t };