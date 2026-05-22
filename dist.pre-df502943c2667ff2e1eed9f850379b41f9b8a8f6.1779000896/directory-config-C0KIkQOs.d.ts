import { u as ChannelDirectoryEntry } from "./types.core-DWkvQuBM.js";
import { t as DirectoryConfigParams } from "./directory-types-CIHrz66J.js";
//#region extensions/telegram/src/directory-config.d.ts
declare const listTelegramDirectoryPeersFromConfig: (configParams: DirectoryConfigParams) => Promise<ChannelDirectoryEntry[]>;
declare const listTelegramDirectoryGroupsFromConfig: (configParams: DirectoryConfigParams) => Promise<ChannelDirectoryEntry[]>;
//#endregion
export { listTelegramDirectoryPeersFromConfig as n, listTelegramDirectoryGroupsFromConfig as t };