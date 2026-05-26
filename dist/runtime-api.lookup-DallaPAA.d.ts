import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { u as ChannelDirectoryEntry } from "./types.core-BkmTlRzr.js";
import { t as DirectoryConfigParams } from "./directory-types-CFWi-cc7.js";
//#region extensions/discord/src/audit-core.d.ts
type DiscordChannelPermissionsAuditEntry = {
  channelId: string;
  ok: boolean;
  missing?: string[];
  error?: string | null;
  matchKey?: string;
  matchSource?: "id";
};
type DiscordChannelPermissionsAudit = {
  ok: boolean;
  checkedChannels: number;
  unresolvedChannels: number;
  channels: DiscordChannelPermissionsAuditEntry[];
  elapsedMs: number;
};
//#endregion
//#region extensions/discord/src/audit.d.ts
declare function collectDiscordAuditChannelIds(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): {
  channelIds: string[];
  unresolvedChannels: number;
};
declare function auditDiscordChannelPermissions(params: {
  cfg: OpenClawConfig;
  token: string;
  accountId?: string | null;
  channelIds: string[];
  timeoutMs: number;
}): Promise<DiscordChannelPermissionsAudit>;
//#endregion
//#region extensions/discord/src/directory-live.d.ts
declare function listDiscordDirectoryGroupsLive(params: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]>;
declare function listDiscordDirectoryPeersLive(params: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]>;
//#endregion
//#region extensions/discord/src/resolve-channels.d.ts
type DiscordChannelResolution = {
  input: string;
  resolved: boolean;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
  archived?: boolean;
  note?: string;
};
declare function resolveDiscordChannelAllowlist(params: {
  token: string;
  entries: string[];
  fetcher?: typeof fetch;
}): Promise<DiscordChannelResolution[]>;
//#endregion
//#region extensions/discord/src/resolve-users.d.ts
type DiscordUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  guildId?: string;
  guildName?: string;
  note?: string;
};
declare function resolveDiscordUserAllowlist(params: {
  token: string;
  entries: string[];
  fetcher?: typeof fetch;
}): Promise<DiscordUserResolution[]>;
//#endregion
export { listDiscordDirectoryGroupsLive as a, collectDiscordAuditChannelIds as c, resolveDiscordChannelAllowlist as i, resolveDiscordUserAllowlist as n, listDiscordDirectoryPeersLive as o, DiscordChannelResolution as r, auditDiscordChannelPermissions as s, DiscordUserResolution as t };