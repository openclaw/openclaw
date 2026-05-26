import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { S as MarkdownTableMode } from "./types.base-DS--yneR.js";
import { t as OutboundMediaAccess } from "./load-options-CTuppEe4.js";
import { n as PollInput } from "./polls-CfHkU59X.js";
import { f as ChunkMode } from "./outbound.types-D7agCOHK.js";
import { t as RetryConfig } from "./retry-CrxGEpqH.js";
import { Et as APIRole, I as APIGuildMember, S as APIMessage, it as APIChannel, kt as Snowflake } from "./payload-U2icqU80.js";
import { a as APIGuildScheduledEventRecurrenceRule, i as APIGuildScheduledEventEntityMetadata, n as APIVoiceState, o as GuildScheduledEventEntityType, r as APIGuildScheduledEvent, s as GuildScheduledEventPrivacyLevel } from "./voice-Damkqy6G.js";
import { t as RequestClient } from "./rest-CE8PF7Nu.js";
import { S as DiscordTimeoutTarget, a as DiscordEmojiUpload, b as DiscordThreadCreate, c as DiscordModerationTarget, f as DiscordReactionSummary, g as DiscordSearchQuery, i as DiscordChannelPermissionSet, l as DiscordPermissionsSummary, m as DiscordRoleChange, n as DiscordChannelEdit, o as DiscordMessageEdit, r as DiscordChannelMove, s as DiscordMessageQuery, t as DiscordChannelCreate, u as DiscordReactOpts, v as DiscordSendResult, x as DiscordThreadList, y as DiscordStickerUpload } from "./send.types-BusQAPVK.js";
import { n as DiscordSendEmbeds, t as DiscordSendComponents } from "./send.shared-DFtuanuS.js";

//#region node_modules/discord-api-types/rest/v10/guildScheduledEvent.d.ts
/**
 * @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#create-guild-scheduled-event}
 */
interface RESTPostAPIGuildScheduledEventJSONBody {
  /**
   * The stage channel id of the guild event
   */
  channel_id?: Snowflake | undefined;
  /**
   * The name of the guild event
   */
  name: string;
  /**
   * The privacy level of the guild event
   */
  privacy_level: GuildScheduledEventPrivacyLevel;
  /**
   * The time to schedule the guild event at
   */
  scheduled_start_time: string;
  /**
   * The time when the scheduled event is scheduled to end
   */
  scheduled_end_time?: string | undefined;
  /**
   * The description of the guild event
   */
  description?: string | undefined;
  /**
   * The scheduled entity type of the guild event
   */
  entity_type: GuildScheduledEventEntityType;
  /**
   * The entity metadata of the scheduled event
   */
  entity_metadata?: APIGuildScheduledEventEntityMetadata | undefined;
  /**
   * The cover image of the scheduled event
   */
  image?: string | null | undefined;
  /**
   * The definition for how often this event should recur
   */
  recurrence_rule?: APIGuildScheduledEventRecurrenceRule | undefined;
}
//#endregion
//#region extensions/discord/src/send.channels.d.ts
declare function createChannelDiscord(payload: DiscordChannelCreate, opts: DiscordReactOpts): Promise<APIChannel>;
declare function editChannelDiscord(payload: DiscordChannelEdit, opts: DiscordReactOpts): Promise<APIChannel>;
declare function deleteChannelDiscord(channelId: string, opts: DiscordReactOpts): Promise<{
  ok: boolean;
  channelId: string;
}>;
declare function moveChannelDiscord(payload: DiscordChannelMove, opts: DiscordReactOpts): Promise<{
  ok: boolean;
}>;
declare function setChannelPermissionDiscord(payload: DiscordChannelPermissionSet, opts: DiscordReactOpts): Promise<{
  ok: boolean;
}>;
declare function removeChannelPermissionDiscord(channelId: string, targetId: string, opts: DiscordReactOpts): Promise<{
  ok: boolean;
}>;
//#endregion
//#region extensions/discord/src/send.emojis-stickers.d.ts
declare function listGuildEmojisDiscord(guildId: string, opts: DiscordReactOpts): Promise<unknown>;
declare function uploadEmojiDiscord(payload: DiscordEmojiUpload, opts: DiscordReactOpts): Promise<unknown>;
declare function uploadStickerDiscord(payload: DiscordStickerUpload, opts: DiscordReactOpts): Promise<unknown>;
//#endregion
//#region extensions/discord/src/send.guild.d.ts
declare function fetchMemberInfoDiscord(guildId: string, userId: string, opts: DiscordReactOpts): Promise<APIGuildMember>;
declare function fetchRoleInfoDiscord(guildId: string, opts: DiscordReactOpts): Promise<APIRole[]>;
declare function addRoleDiscord(payload: DiscordRoleChange, opts: DiscordReactOpts): Promise<{
  ok: boolean;
}>;
declare function removeRoleDiscord(payload: DiscordRoleChange, opts: DiscordReactOpts): Promise<{
  ok: boolean;
}>;
declare function fetchChannelInfoDiscord(channelId: string, opts: DiscordReactOpts): Promise<APIChannel>;
declare function listGuildChannelsDiscord(guildId: string, opts: DiscordReactOpts): Promise<APIChannel[]>;
declare function fetchVoiceStatusDiscord(guildId: string, userId: string, opts: DiscordReactOpts): Promise<APIVoiceState>;
declare function listScheduledEventsDiscord(guildId: string, opts: DiscordReactOpts): Promise<APIGuildScheduledEvent[]>;
declare function resolveEventCoverImage(imageUrl: string, opts?: {
  localRoots?: readonly string[];
}): Promise<string>;
declare function createScheduledEventDiscord(guildId: string, payload: RESTPostAPIGuildScheduledEventJSONBody, opts: DiscordReactOpts): Promise<APIGuildScheduledEvent>;
declare function timeoutMemberDiscord(payload: DiscordTimeoutTarget, opts: DiscordReactOpts): Promise<APIGuildMember>;
declare function kickMemberDiscord(payload: DiscordModerationTarget, opts: DiscordReactOpts): Promise<{
  ok: boolean;
}>;
declare function banMemberDiscord(payload: DiscordModerationTarget & {
  deleteMessageDays?: number;
}, opts: DiscordReactOpts): Promise<{
  ok: boolean;
}>;
//#endregion
//#region extensions/discord/src/send.messages.d.ts
declare function readMessagesDiscord(channelId: string, query: DiscordMessageQuery | undefined, opts: DiscordReactOpts): Promise<APIMessage[]>;
declare function fetchMessageDiscord(channelId: string, messageId: string, opts: DiscordReactOpts): Promise<APIMessage>;
declare function editMessageDiscord(channelId: string, messageId: string, payload: DiscordMessageEdit, opts: DiscordReactOpts): Promise<APIMessage>;
declare function deleteMessageDiscord(channelId: string, messageId: string, opts: DiscordReactOpts): Promise<{
  ok: boolean;
}>;
declare function pinMessageDiscord(channelId: string, messageId: string, opts: DiscordReactOpts): Promise<{
  ok: boolean;
}>;
declare function unpinMessageDiscord(channelId: string, messageId: string, opts: DiscordReactOpts): Promise<{
  ok: boolean;
}>;
declare function listPinsDiscord(channelId: string, opts: DiscordReactOpts): Promise<APIMessage[]>;
declare function createThreadDiscord(channelId: string, payload: DiscordThreadCreate, opts: DiscordReactOpts): Promise<APIChannel>;
declare function listThreadsDiscord(payload: DiscordThreadList, opts: DiscordReactOpts): Promise<unknown>;
declare function searchMessagesDiscord(query: DiscordSearchQuery, opts: DiscordReactOpts): Promise<unknown>;
//#endregion
//#region extensions/discord/src/send.outbound.d.ts
type DiscordSendOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  filename?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  verbose?: boolean;
  rest?: RequestClient;
  replyTo?: string;
  retry?: RetryConfig;
  textLimit?: number;
  maxLinesPerMessage?: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  components?: DiscordSendComponents;
  embeds?: DiscordSendEmbeds;
  silent?: boolean;
  suppressEmbeds?: boolean;
};
declare function sendMessageDiscord(to: string, text: string, opts: DiscordSendOpts): Promise<DiscordSendResult>;
declare function sendStickerDiscord(to: string, stickerIds: string[], opts: DiscordSendOpts & {
  content?: string;
}): Promise<DiscordSendResult>;
declare function sendPollDiscord(to: string, poll: PollInput, opts: DiscordSendOpts & {
  content?: string;
}): Promise<DiscordSendResult>;
//#endregion
//#region extensions/discord/src/send.webhook.d.ts
type DiscordWebhookSendOpts = {
  cfg: OpenClawConfig;
  webhookId: string;
  webhookToken: string;
  accountId?: string;
  threadId?: string | number;
  replyTo?: string;
  username?: string;
  avatarUrl?: string;
  wait?: boolean;
};
declare function sendWebhookMessageDiscord(text: string, opts: DiscordWebhookSendOpts): Promise<DiscordSendResult>;
//#endregion
//#region extensions/discord/src/send.voice.d.ts
type VoiceMessageOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  rest?: RequestClient;
  replyTo?: string;
  retry?: RetryConfig;
  silent?: boolean;
};
/**
 * Send a voice message to Discord.
 *
 * Voice messages are a special Discord feature that displays audio with a waveform
 * visualization. They require OGG/Opus format and cannot include text content.
 *
 * @param to - Recipient (user ID for DM or channel ID)
 * @param audioPath - Path to local audio file (will be converted to OGG/Opus if needed)
 * @param opts - Send options
 */
declare function sendVoiceMessageDiscord(to: string, audioPath: string, opts: VoiceMessageOpts): Promise<DiscordSendResult>;
//#endregion
//#region extensions/discord/src/send.typing.d.ts
declare function sendTypingDiscord(channelId: string, opts: DiscordReactOpts): Promise<{
  ok: boolean;
  channelId: string;
}>;
//#endregion
//#region extensions/discord/src/send.permissions.d.ts
/**
 * Fetch guild-level permissions for a user. This does not include channel-specific overwrites.
 */
declare function fetchMemberGuildPermissionsDiscord(guildId: string, userId: string, opts: DiscordReactOpts): Promise<bigint | null>;
/**
 * Returns true when the user has ADMINISTRATOR or any required permission bit.
 */
declare function hasAnyGuildPermissionDiscord(guildId: string, userId: string, requiredPermissions: bigint[], opts: DiscordReactOpts): Promise<boolean>;
/**
 * Returns true when the user has ADMINISTRATOR or all required permission bits.
 */
declare function hasAllGuildPermissionsDiscord(guildId: string, userId: string, requiredPermissions: bigint[], opts: DiscordReactOpts): Promise<boolean>;
declare function fetchChannelPermissionsDiscord(channelId: string, opts: DiscordReactOpts): Promise<DiscordPermissionsSummary>;
//#endregion
//#region extensions/discord/src/send.reactions.d.ts
declare function reactMessageDiscord(channelId: string, messageId: string, emoji: string, opts: DiscordReactOpts): Promise<{
  ok: boolean;
}>;
declare function removeReactionDiscord(channelId: string, messageId: string, emoji: string, opts: DiscordReactOpts): Promise<{
  ok: boolean;
}>;
declare function removeOwnReactionsDiscord(channelId: string, messageId: string, opts: DiscordReactOpts): Promise<{
  ok: true;
  removed: string[];
}>;
declare function fetchReactionsDiscord(channelId: string, messageId: string, opts: DiscordReactOpts & {
  limit?: number;
}): Promise<DiscordReactionSummary[]>;
//#endregion
export { fetchRoleInfoDiscord as A, uploadStickerDiscord as B, searchMessagesDiscord as C, createScheduledEventDiscord as D, banMemberDiscord as E, removeRoleDiscord as F, removeChannelPermissionDiscord as G, deleteChannelDiscord as H, resolveEventCoverImage as I, setChannelPermissionDiscord as K, timeoutMemberDiscord as L, kickMemberDiscord as M, listGuildChannelsDiscord as N, fetchChannelInfoDiscord as O, listScheduledEventsDiscord as P, listGuildEmojisDiscord as R, readMessagesDiscord as S, addRoleDiscord as T, editChannelDiscord as U, createChannelDiscord as V, moveChannelDiscord as W, editMessageDiscord as _, fetchChannelPermissionsDiscord as a, listThreadsDiscord as b, hasAnyGuildPermissionDiscord as c, sendWebhookMessageDiscord as d, sendMessageDiscord as f, deleteMessageDiscord as g, createThreadDiscord as h, removeReactionDiscord as i, fetchVoiceStatusDiscord as j, fetchMemberInfoDiscord as k, sendTypingDiscord as l, sendStickerDiscord as m, reactMessageDiscord as n, fetchMemberGuildPermissionsDiscord as o, sendPollDiscord as p, removeOwnReactionsDiscord as r, hasAllGuildPermissionsDiscord as s, fetchReactionsDiscord as t, sendVoiceMessageDiscord as u, fetchMessageDiscord as v, unpinMessageDiscord as w, pinMessageDiscord as x, listPinsDiscord as y, uploadEmojiDiscord as z };