import type { ChannelId, ChannelPlugin } from "./types.js";
export declare function listChannelPlugins(): ChannelPlugin[];
export declare function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined;
export declare function normalizeChannelId(raw?: string | null): ChannelId | null;
export { listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig, listSlackDirectoryGroupsFromConfig, listSlackDirectoryPeersFromConfig, listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig, listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig, } from "./directory-config.js";
export { applyChannelMatchMeta, buildChannelKeyCandidates, normalizeChannelSlug, resolveChannelEntryMatch, resolveChannelEntryMatchWithFallback, resolveChannelMatchConfig, resolveNestedAllowlistDecision, type ChannelEntryMatch, type ChannelMatchSource, } from "./channel-config.js";
export { formatAllowlistMatchMeta, type AllowlistMatch, type AllowlistMatchSource, } from "./allowlist-match.js";
export type { ChannelId, ChannelPlugin } from "./types.js";
