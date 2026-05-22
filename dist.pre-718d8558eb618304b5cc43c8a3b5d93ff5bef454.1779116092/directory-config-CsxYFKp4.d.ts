import { u as ChannelDirectoryEntry } from "./types.core-CgjRAtD6.js";
import { t as DirectoryConfigParams } from "./directory-types-C4Y3Qc5e.js";
//#region extensions/discord/src/directory-config.d.ts
declare const listDiscordDirectoryPeersFromConfig: (configParams: DirectoryConfigParams) => Promise<ChannelDirectoryEntry[]>;
declare const listDiscordDirectoryGroupsFromConfig: (configParams: DirectoryConfigParams) => Promise<ChannelDirectoryEntry[]>;
//#endregion
export { listDiscordDirectoryPeersFromConfig as n, listDiscordDirectoryGroupsFromConfig as t };