import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { P as MessageReceipt } from "./types-CxkJAgkR.js";
import { t as RetryConfig } from "./retry-CrxGEpqH.js";
import { t as RequestClient } from "./rest-CE8PF7Nu.js";
//#region extensions/discord/src/send.types.d.ts
declare class DiscordSendError extends Error {
  kind?: "missing-permissions" | "dm-blocked";
  channelId?: string;
  missingPermissions?: string[];
  discordCode?: number;
  status?: number;
  constructor(message: string, opts?: Partial<DiscordSendError>);
  toString(): string;
}
type DiscordSendResult = {
  messageId: string;
  channelId: string;
  receipt: MessageReceipt;
};
type DiscordRuntimeAccountContext = {
  cfg: OpenClawConfig;
  accountId: string;
};
type DiscordReactOpts = {
  cfg: OpenClawConfig;
  accountId?: string;
  token?: string;
  rest?: RequestClient;
  verbose?: boolean;
  retry?: RetryConfig;
};
type DiscordReactionRuntimeContext = DiscordRuntimeAccountContext & {
  rest: RequestClient;
};
type DiscordReactionUser = {
  id: string;
  username?: string;
  tag?: string;
};
type DiscordReactionSummary = {
  emoji: {
    id?: string | null;
    name?: string | null;
    raw: string;
  };
  count: number;
  users: DiscordReactionUser[];
};
type DiscordPermissionsSummary = {
  channelId: string;
  guildId?: string;
  permissions: string[];
  raw: string;
  isDm: boolean;
  channelType?: number;
};
type DiscordMessageQuery = {
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
};
type DiscordMessageEdit = {
  content?: string;
  flags?: number;
};
type DiscordThreadCreate = {
  messageId?: string;
  name: string;
  autoArchiveMinutes?: number;
  content?: string; /** Discord thread type (default: PublicThread for standalone threads). */
  type?: number; /** Tag IDs to apply when creating a forum/media thread (Discord `applied_tags`). */
  appliedTags?: string[];
};
type DiscordThreadList = {
  guildId: string;
  channelId?: string;
  includeArchived?: boolean;
  before?: string;
  limit?: number;
};
type DiscordSearchQuery = {
  guildId: string;
  content: string;
  channelIds?: string[];
  authorIds?: string[];
  limit?: number;
};
type DiscordRoleChange = {
  guildId: string;
  userId: string;
  roleId: string;
};
type DiscordModerationTarget = {
  guildId: string;
  userId: string;
  reason?: string;
};
type DiscordTimeoutTarget = DiscordModerationTarget & {
  until?: string;
  durationMinutes?: number;
};
type DiscordEmojiUpload = {
  guildId: string;
  name: string;
  mediaUrl: string;
  roleIds?: string[];
};
type DiscordStickerUpload = {
  guildId: string;
  name: string;
  description: string;
  tags: string;
  mediaUrl: string;
};
type DiscordChannelCreate = {
  guildId: string;
  name: string;
  type?: number;
  parentId?: string;
  topic?: string;
  position?: number;
  nsfw?: boolean;
};
type DiscordForumTag = {
  id?: string;
  name: string;
  moderated?: boolean;
  emoji_id?: string | null;
  emoji_name?: string | null;
};
type DiscordChannelEdit = {
  channelId: string;
  name?: string;
  topic?: string;
  position?: number;
  parentId?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  archived?: boolean;
  locked?: boolean;
  autoArchiveDuration?: number;
  availableTags?: DiscordForumTag[];
};
type DiscordChannelMove = {
  guildId: string;
  channelId: string;
  parentId?: string | null;
  position?: number;
};
type DiscordChannelPermissionSet = {
  channelId: string;
  targetId: string;
  targetType: 0 | 1;
  allow?: string;
  deny?: string;
};
//#endregion
export { DiscordTimeoutTarget as S, DiscordSendError as _, DiscordEmojiUpload as a, DiscordThreadCreate as b, DiscordModerationTarget as c, DiscordReactionRuntimeContext as d, DiscordReactionSummary as f, DiscordSearchQuery as g, DiscordRuntimeAccountContext as h, DiscordChannelPermissionSet as i, DiscordPermissionsSummary as l, DiscordRoleChange as m, DiscordChannelEdit as n, DiscordMessageEdit as o, DiscordReactionUser as p, DiscordChannelMove as r, DiscordMessageQuery as s, DiscordChannelCreate as t, DiscordReactOpts as u, DiscordSendResult as v, DiscordThreadList as x, DiscordStickerUpload as y };