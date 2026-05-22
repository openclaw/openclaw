import { u as ChannelDirectoryEntry } from "./types.core-CQScvK0N.js";
import { t as DirectoryConfigParams } from "./directory-types-DiOVxrCZ.js";
//#region extensions/whatsapp/src/directory-config.d.ts
declare function listWhatsAppDirectoryPeersFromConfig(params: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]>;
declare function listWhatsAppDirectoryGroupsFromConfig(params: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]>;
//#endregion
export { listWhatsAppDirectoryPeersFromConfig as n, listWhatsAppDirectoryGroupsFromConfig as t };