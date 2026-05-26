//#region node_modules/discord-api-types/globals.d.ts
/**
 * @see {@link https://discord.com/developers/docs/reference#snowflakes}
 */
type Snowflake = string;
/**
 * @see {@link https://discord.com/developers/docs/topics/permissions}
 */
type Permissions = string;
//#endregion
//#region node_modules/discord-api-types/rest/common.d.ts
/**
 * @see {@link https://discord.com/developers/docs/reference#locales}
 */
declare enum Locale {
  Indonesian = "id",
  EnglishUS = "en-US",
  EnglishGB = "en-GB",
  Bulgarian = "bg",
  ChineseCN = "zh-CN",
  ChineseTW = "zh-TW",
  Croatian = "hr",
  Czech = "cs",
  Danish = "da",
  Dutch = "nl",
  Finnish = "fi",
  French = "fr",
  German = "de",
  Greek = "el",
  Hindi = "hi",
  Hungarian = "hu",
  Italian = "it",
  Japanese = "ja",
  Korean = "ko",
  Lithuanian = "lt",
  Norwegian = "no",
  Polish = "pl",
  PortugueseBR = "pt-BR",
  Romanian = "ro",
  Russian = "ru",
  SpanishES = "es-ES",
  SpanishLATAM = "es-419",
  Swedish = "sv-SE",
  Thai = "th",
  Turkish = "tr",
  Ukrainian = "uk",
  Vietnamese = "vi"
}
//#endregion
//#region node_modules/discord-api-types/payloads/common.d.ts
type LocalizationMap = Partial<Record<Locale, string | null>>;
//#endregion
//#region node_modules/discord-api-types/utils/internals.d.ts
type _NonNullableFields<T> = { [P in keyof T]: NonNullable<T[P]> };
type _AddUndefinedToPossiblyUndefinedPropertiesOfInterface<Base> = { [K in keyof Base]: Base[K] extends Exclude<Base[K], undefined> ? _AddUndefinedToPossiblyUndefinedPropertiesOfInterface<Base[K]> : _AddUndefinedToPossiblyUndefinedPropertiesOfInterface<Base[K]> | undefined };
//#endregion
//#region node_modules/discord-api-types/payloads/v10/permissions.d.ts
/**
 * @see {@link https://discord.com/developers/docs/topics/permissions#role-object}
 */
interface APIRole {
  /**
   * Role id
   */
  id: Snowflake;
  /**
   * Role name
   */
  name: string;
  /**
   * Integer representation of hexadecimal color code
   *
   * @deprecated Use `colors` instead.
   * @remarks `color` will still be returned by the API, but using the `colors` field is recommended when doing requests.
   */
  color: number;
  /**
   * The role's colors
   */
  colors: APIRoleColors;
  /**
   * If this role is pinned in the user listing
   */
  hoist: boolean;
  /**
   * The role icon hash
   */
  icon?: string | null;
  /**
   * The role unicode emoji as a standard emoji
   */
  unicode_emoji?: string | null;
  /**
   * Position of this role
   */
  position: number;
  /**
   * Permission bit set
   *
   * @see {@link https://en.wikipedia.org/wiki/Bit_field}
   */
  permissions: Permissions;
  /**
   * Whether this role is managed by an integration
   */
  managed: boolean;
  /**
   * Whether this role is mentionable
   */
  mentionable: boolean;
  /**
   * The tags this role has
   */
  tags?: APIRoleTags;
  /**
   * Role flags
   */
  flags: RoleFlags;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/permissions#role-object-role-tags-structure}
 */
interface APIRoleTags {
  /**
   * The id of the bot this role belongs to
   */
  bot_id?: Snowflake;
  /**
   * Whether this is the guild's premium subscriber role
   */
  premium_subscriber?: null;
  /**
   * The id of the integration this role belongs to
   */
  integration_id?: Snowflake;
  /**
   * The id of this role's subscription sku and listing
   */
  subscription_listing_id?: Snowflake;
  /**
   * Whether this role is available for purchase
   */
  available_for_purchase?: null;
  /**
   * Whether this role is a guild's linked role
   */
  guild_connections?: null;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/permissions#role-object-role-flags}
 */
declare enum RoleFlags {
  /**
   * Role can be selected by members in an onboarding prompt
   */
  InPrompt = 1
}
/**
 * @see {@link https://discord.com/developers/docs/topics/permissions#role-colors-object}
 */
interface APIRoleColors {
  /**
   * The primary color for the role
   */
  primary_color: number;
  /**
   * The secondary color for the role, this will make the role a gradient between the other provided colors
   */
  secondary_color: number | null;
  /**
   * The tertiary color for the role, this will turn the gradient into a holographic style
   *
   * @remarks When sending `tertiary_color` the API enforces the role color to be a holographic style with values of `primary_color = 11127295`, `secondary_color = 16759788`, and `tertiary_color = 16761760`.
   */
  tertiary_color: number | null;
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/user.d.ts
/**
 * @see {@link https://discord.com/developers/docs/resources/user#user-object}
 */
interface APIUser {
  /**
   * The user's id
   */
  id: Snowflake;
  /**
   * The user's username, not unique across the platform
   */
  username: string;
  /**
   * The user's Discord-tag
   */
  discriminator: string;
  /**
   * The user's display name, if it is set
   */
  global_name: string | null;
  /**
   * The user's avatar hash
   *
   * @see {@link https://discord.com/developers/docs/reference#image-formatting}
   */
  avatar: string | null;
  /**
   * Whether the user belongs to an OAuth2 application
   */
  bot?: boolean;
  /**
   * Whether the user is an Official Discord System user (part of the urgent message system)
   */
  system?: boolean;
  /**
   * Whether the user has two factor enabled on their account
   */
  mfa_enabled?: boolean;
  /**
   * The user's banner hash
   *
   * @see {@link https://discord.com/developers/docs/reference#image-formatting}
   */
  banner?: string | null;
  /**
   * The user's banner color encoded as an integer representation of hexadecimal color code
   */
  accent_color?: number | null;
  /**
   * The user's chosen language option
   */
  locale?: string;
  /**
   * Whether the email on this account has been verified
   */
  verified?: boolean;
  /**
   * The user's email
   */
  email?: string | null;
  /**
   * The flags on a user's account
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object-user-flags}
   */
  flags?: UserFlags;
  /**
   * The type of Nitro subscription on a user's account
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object-premium-types}
   */
  premium_type?: UserPremiumType;
  /**
   * The public flags on a user's account
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object-user-flags}
   */
  public_flags?: UserFlags;
  /**
   * The user's avatar decoration hash
   *
   * @see {@link https://discord.com/developers/docs/reference#image-formatting}
   * @deprecated Use {@link APIUser.avatar_decoration_data} instead
   */
  avatar_decoration?: string | null;
  /**
   * The data for the user's avatar decoration
   *
   * @see {@link https://discord.com/developers/docs/resources/user#avatar-decoration-data-object}
   */
  avatar_decoration_data?: APIAvatarDecorationData | null;
  /**
   * The data for the user's collectibles
   *
   * @see {@link https://discord.com/developers/docs/resources/user#collectibles}
   */
  collectibles?: APICollectibles | null;
  /**
   * The user's primary guild
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object-user-primary-guild}
   */
  primary_guild?: APIUserPrimaryGuild | null;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/user#user-object-user-flags}
 */
declare enum UserFlags {
  /**
   * Discord Employee
   */
  Staff = 1,
  /**
   * Partnered Server Owner
   */
  Partner = 2,
  /**
   * HypeSquad Events Member
   */
  Hypesquad = 4,
  /**
   * Bug Hunter Level 1
   */
  BugHunterLevel1 = 8,
  /**
   * @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  MFASMS = 16,
  /**
   * @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  PremiumPromoDismissed = 32,
  /**
   * House Bravery Member
   */
  HypeSquadOnlineHouse1 = 64,
  /**
   * House Brilliance Member
   */
  HypeSquadOnlineHouse2 = 128,
  /**
   * House Balance Member
   */
  HypeSquadOnlineHouse3 = 256,
  /**
   * Early Nitro Supporter
   */
  PremiumEarlySupporter = 512,
  /**
   * User is a {@link https://discord.com/developers/docs/topics/teams | team}
   */
  TeamPseudoUser = 1024,
  /**
   * @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  HasUnreadUrgentMessages = 8192,
  /**
   * Bug Hunter Level 2
   */
  BugHunterLevel2 = 16384,
  /**
   * Verified Bot
   */
  VerifiedBot = 65536,
  /**
   * Early Verified Bot Developer
   */
  VerifiedDeveloper = 131072,
  /**
   * Moderator Programs Alumni
   */
  CertifiedModerator = 262144,
  /**
   * Bot uses only {@link https://discord.com/developers/docs/interactions/receiving-and-responding#receiving-an-interaction | HTTP interactions} and is shown in the online member list
   */
  BotHTTPInteractions = 524288,
  /**
   * User has been identified as spammer
   *
   * @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  Spammer = 1048576,
  /**
   * @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  DisablePremium = 2097152,
  /**
   * User is an {@link https://support-dev.discord.com/hc/articles/10113997751447 | Active Developer}
   *
   * @deprecated This user flag is no longer available. See {@link https://support-dev.discord.com/hc/articles/10113997751447-Active-Developer-Badge} for more information.
   */
  ActiveDeveloper = 4194304,
  /**
   * User's account has been {@link https://support.discord.com/hc/articles/6461420677527 | quarantined} based on recent activity
   *
   * @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   * @privateRemarks
   *
   * This value would be `1 << 44`, but bit shifting above `1 << 30` requires bigints
   */
  Quarantined = 17592186044416,
  /**
   * @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   * @privateRemarks
   *
   * This value would be `1 << 50`, but bit shifting above `1 << 30` requires bigints
   */
  Collaborator = 1125899906842624,
  /**
   * @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   * @privateRemarks
   *
   * This value would be `1 << 51`, but bit shifting above `1 << 30` requires bigints
   */
  RestrictedCollaborator = 2251799813685248
}
/**
 * @see {@link https://discord.com/developers/docs/resources/user#user-object-premium-types}
 */
declare enum UserPremiumType {
  None = 0,
  NitroClassic = 1,
  Nitro = 2,
  NitroBasic = 3
}
/**
 * @see {@link https://discord.com/developers/docs/resources/user#avatar-decoration-data-object}
 */
interface APIAvatarDecorationData {
  /**
   * The avatar decoration hash
   *
   * @see {@link https://discord.com/developers/docs/reference#image-formatting}
   */
  asset: string;
  /**
   * The id of the avatar decoration's SKU
   */
  sku_id: Snowflake;
}
/**
 * The collectibles the user has, excluding Avatar Decorations and Profile Effects.
 *
 * @see {@link https://discord.com/developers/docs/resources/user#collectibles}
 */
interface APICollectibles {
  /**
   * Object mapping of {@link APINameplateData}
   */
  nameplate?: APINameplateData;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/user#nameplate}
 */
interface APINameplateData {
  /**
   * ID of the nameplate SKU
   */
  sku_id: Snowflake;
  /**
   * Path to the nameplate asset
   *
   * @example `nameplates/nameplates/twilight/`
   */
  asset: string;
  /**
   * The label of this nameplate. Currently unused
   */
  label: string;
  /**
   * Background color of the nameplate
   */
  palette: NameplatePalette;
}
/**
 * Background color of a nameplate.
 */
declare enum NameplatePalette {
  Berry = "berry",
  BubbleGum = "bubble_gum",
  Clover = "clover",
  Cobalt = "cobalt",
  Crimson = "crimson",
  Forest = "forest",
  Lemon = "lemon",
  Sky = "sky",
  Teal = "teal",
  Violet = "violet",
  White = "white"
}
/**
 * @see {@link https://discord.com/developers/docs/resources/user#user-object-user-primary-guild}
 */
interface APIUserPrimaryGuild {
  /**
   * The id of the user's primary guild
   */
  identity_guild_id: Snowflake | null;
  /**
   * Whether the user is displaying the primary guild's server tag.
   * This can be `null` if the system clears the identity, e.g. because the server no longer supports tags
   */
  identity_enabled: boolean | null;
  /**
   * The text of the user's server tag. Limited to 4 characters
   */
  tag: string | null;
  /**
   * The server tag badge hash
   *
   * @see {@link https://discord.com/developers/docs/reference#image-formatting}
   */
  badge: string | null;
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/emoji.d.ts
/**
 * Not documented but mentioned
 */
interface APIPartialEmoji {
  /**
   * Emoji id
   */
  id: Snowflake | null;
  /**
   * Emoji name (can be null only in reaction emoji objects)
   */
  name: string | null;
  /**
   * Whether this emoji is animated
   */
  animated?: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/emoji#emoji-object-emoji-structure}
 */
interface APIEmoji extends APIPartialEmoji {
  /**
   * Roles this emoji is whitelisted to
   */
  roles?: APIRole['id'][];
  /**
   * User that created this emoji
   */
  user?: APIUser;
  /**
   * Whether this emoji must be wrapped in colons
   */
  require_colons?: boolean;
  /**
   * Whether this emoji is managed
   */
  managed?: boolean;
  /**
   * Whether this emoji can be used, may be false due to loss of Server Boosts
   */
  available?: boolean;
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/channel.d.ts
interface APIBasePartialChannel {
  /**
   * The id of the channel
   */
  id: Snowflake;
  /**
   * The type of the channel
   *
   * @see {@link https://discord.com/developers/docs/resources/channel#channel-object-channel-types}
   */
  type: ChannelType;
}
interface APINameableChannel {
  /**
   * The name of the channel (1-100 characters)
   */
  name?: string | null;
}
/**
 * Not documented, but partial only includes id, name, and type
 */
interface APIPartialChannel extends APIBasePartialChannel, APINameableChannel {}
/**
 * This interface is used to allow easy extension for other channel types. While
 * also allowing `APIPartialChannel` to be used without breaking.
 */
interface APIChannelBase<T extends ChannelType> extends APIBasePartialChannel {
  type: T;
  flags?: ChannelFlags;
}
type TextChannelType = ChannelType.AnnouncementThread | ChannelType.DM | ChannelType.GroupDM | ChannelType.GuildAnnouncement | ChannelType.GuildStageVoice | ChannelType.GuildText | ChannelType.GuildVoice | ChannelType.PrivateThread | ChannelType.PublicThread;
type GuildChannelType = Exclude<ChannelType, ChannelType.DM | ChannelType.GroupDM>;
type ApplicationCommandOptionAllowedChannelType = Exclude<ChannelType, ChannelType.DM | ChannelType.GroupDM | ChannelType.GuildDirectory>;
interface APISlowmodeChannel<T extends ChannelType> extends APIChannelBase<T> {
  /**
   * Amount of seconds a user has to wait before sending another message (0-21600);
   * bots, as well as users with the permission `BYPASS_SLOWMODE`, are unaffected
   *
   * `rate_limit_per_user` also applies to thread creation. Users can send one message and create one thread during each `rate_limit_per_user` interval.
   *
   * For thread channels, `rate_limit_per_user` is only returned if the field is set to a non-zero and non-null value.
   * The absence of this field in API calls and Gateway events should indicate that slowmode has been reset to the default value.
   */
  rate_limit_per_user?: number;
}
interface APISortableChannel {
  /**
   * Sorting position of the channel
   */
  position: number;
}
interface APITextBasedChannel<T extends ChannelType> extends APIChannelBase<T>, APISlowmodeChannel<T> {
  /**
   * The id of the last message sent in this channel (may not point to an existing or valid message)
   */
  last_message_id?: Snowflake | null;
}
interface APIPinChannel<T extends ChannelType> extends APIChannelBase<T> {
  /**
   * When the last pinned message was pinned.
   * This may be `null` in events such as `GUILD_CREATE` when a message is not pinned
   */
  last_pin_timestamp?: string | null;
}
interface APIGuildChannel<T extends GuildChannelType = GuildChannelType> extends APIChannelBase<T> {
  /**
   * The name of the channel (1-100 characters)
   */
  name: string;
  /**
   * The id of the guild (may be missing for some channel objects received over gateway guild dispatches)
   */
  guild_id?: Snowflake;
  /**
   * Explicit permission overwrites for members and roles
   *
   * @see {@link https://discord.com/developers/docs/resources/channel#overwrite-object}
   */
  permission_overwrites?: APIOverwrite[];
  /**
   * ID of the parent category for a channel (each parent category can contain up to 50 channels)
   */
  parent_id?: Snowflake | null;
  /**
   * Whether the channel is nsfw
   */
  nsfw?: boolean;
}
type GuildTextChannelType = Exclude<TextChannelType, ChannelType.DM | ChannelType.GroupDM>;
interface APIGuildTextChannel<T extends ChannelType.GuildForum | ChannelType.GuildMedia | GuildTextChannelType> extends APITextBasedChannel<T>, APIGuildChannel<T>, APISortableChannel, APIPinChannel<T> {
  /**
   * Default duration for newly created threads, in minutes, to automatically archive the thread after recent activity
   */
  default_auto_archive_duration?: ThreadAutoArchiveDuration;
  /**
   * The initial `rate_limit_per_user` to set on newly created threads.
   * This field is copied to the thread at creation time and does not live update
   */
  default_thread_rate_limit_per_user?: number;
  /**
   * The channel topic (0-1024 characters)
   */
  topic?: string | null;
}
type APITextChannel = APIGuildTextChannel<ChannelType.GuildText>;
type APINewsChannel = APIGuildTextChannel<ChannelType.GuildAnnouncement>;
interface APIGuildCategoryChannel extends APIGuildChannel<ChannelType.GuildCategory>, APISortableChannel {
  parent_id?: null;
}
interface APIVoiceChannelBase<T extends GuildChannelType> extends APIGuildChannel<T>, APISortableChannel, APITextBasedChannel<T>, APISlowmodeChannel<T> {
  /**
   * The bitrate (in bits) of the voice or stage channel
   */
  bitrate?: number;
  /**
   * The user limit of the voice or stage channel
   */
  user_limit?: number;
  /**
   * Voice region id for the voice or stage channel, automatic when set to `null`
   *
   * @see {@link https://discord.com/developers/docs/resources/voice#voice-region-object}
   */
  rtc_region?: string | null;
  /**
   * The camera video quality mode of the voice or stage channel, `1` when not present
   *
   * @see {@link https://discord.com/developers/docs/resources/channel#channel-object-video-quality-modes}
   */
  video_quality_mode?: VideoQualityMode;
}
type APIGuildVoiceChannel = APIVoiceChannelBase<ChannelType.GuildVoice>;
type APIGuildStageVoiceChannel = APIVoiceChannelBase<ChannelType.GuildStageVoice>;
interface APIDMChannelBase<T extends ChannelType> extends APITextBasedChannel<T>, APIPinChannel<T> {
  /**
   * The recipients of the DM
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  recipients?: APIUser[];
}
interface APIDMChannel extends APIDMChannelBase<ChannelType.DM> {
  /**
   * The name of the channel (always null for DM channels)
   */
  name: null;
}
interface APIGroupDMChannel extends APIDMChannelBase<ChannelType.GroupDM> {
  /**
   * The name of the channel (1-100 characters)
   */
  name: string | null;
  /**
   * Application id of the group DM creator if it is bot-created
   */
  application_id?: Snowflake;
  /**
   * Icon hash
   */
  icon?: string | null;
  /**
   * ID of the DM creator
   */
  owner_id?: Snowflake;
  /**
   * The id of the last message sent in this channel (may not point to an existing or valid message)
   */
  last_message_id?: Snowflake | null;
  /**
   * Whether the channel is managed by an OAuth2 application
   */
  managed?: boolean;
}
type ThreadChannelType = ChannelType.AnnouncementThread | ChannelType.PrivateThread | ChannelType.PublicThread;
interface APIThreadChannel<Type extends ThreadChannelType = ThreadChannelType> extends APITextBasedChannel<Type>, APIGuildChannel<Type>, APIPinChannel<Type> {
  /**
   * The client users member for the thread, only included in select endpoints
   */
  member?: APIThreadMember;
  /**
   * The metadata for a thread channel not shared by other channels
   */
  thread_metadata?: APIThreadMetadata;
  /**
   * Number of messages (not including the initial message or deleted messages) in a thread
   *
   * If the thread was created before July 1, 2022, it stops counting at 50 messages
   */
  message_count?: number;
  /**
   * The approximate member count of the thread, does not count above 50 even if there are more members
   */
  member_count?: number;
  /**
   * ID of the thread creator
   */
  owner_id?: Snowflake;
  /**
   * Number of messages ever sent in a thread
   *
   * Similar to `message_count` on message creation, but won't decrement when a message is deleted
   */
  total_message_sent?: number;
  /**
   * The IDs of the set of tags that have been applied to a thread in a thread-only channel
   */
  applied_tags?: Snowflake[];
  /**
   * ID of the parent channel for the thread
   */
  parent_id?: Snowflake;
}
type APIPublicThreadChannel = APIThreadChannel<ChannelType.PublicThread>;
type APIPrivateThreadChannel = APIThreadChannel<ChannelType.PrivateThread>;
type APIAnnouncementThreadChannel = APIThreadChannel<ChannelType.AnnouncementThread>;
/**
 * @see {@link https://discord.com/developers/docs/resources/channel#forum-tag-object-forum-tag-structure}
 */
interface APIGuildForumTag {
  /**
   * The id of the tag
   */
  id: Snowflake;
  /**
   * The name of the tag (0-20 characters)
   */
  name: string;
  /**
   * Whether this tag can only be added to or removed from threads by a member with the `MANAGE_THREADS` permission
   */
  moderated: boolean;
  /**
   * The id of a guild's custom emoji
   */
  emoji_id: Snowflake | null;
  /**
   * The unicode character of the emoji
   */
  emoji_name: string | null;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/channel#default-reaction-object-default-reaction-structure}
 */
interface APIGuildForumDefaultReactionEmoji {
  /**
   * The id of a guild's custom emoji
   */
  emoji_id: Snowflake | null;
  /**
   * The unicode character of the emoji
   */
  emoji_name: string | null;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/channel/#channel-object-sort-order-types}
 */
declare enum SortOrderType {
  /**
   * Sort forum posts by activity
   */
  LatestActivity = 0,
  /**
   * Sort forum posts by creation time (from most recent to oldest)
   */
  CreationDate = 1
}
/**
 * @see {@link https://discord.com/developers/docs/resources/channel/#channel-object-forum-layout-types}
 */
declare enum ForumLayoutType {
  /**
   * No default has been set for forum channel
   */
  NotSet = 0,
  /**
   * Display posts as a list
   */
  ListView = 1,
  /**
   * Display posts as a collection of tiles
   */
  GalleryView = 2
}
interface APIThreadOnlyChannel<T extends ChannelType.GuildForum | ChannelType.GuildMedia> extends APIGuildChannel<T>, APISortableChannel {
  /**
   * The channel topic (0-4096 characters)
   */
  topic?: string | null;
  /**
   * The id of the last thread created in this channel (may not point to an existing or valid thread)
   */
  last_message_id?: Snowflake | null;
  /**
   * Amount of seconds a user has to wait before creating another thread (0-21600);
   * bots, as well as users with the permission `BYPASS_SLOWMODE`, are unaffected
   *
   * The absence of this field in API calls and Gateway events should indicate that slowmode has been reset to the default value.
   */
  rate_limit_per_user?: number;
  /**
   * When the last pinned message was pinned.
   * This may be `null` in events such as `GUILD_CREATE` when a message is not pinned
   */
  last_pin_timestamp?: string | null;
  /**
   * Default duration for newly created threads, in minutes, to automatically archive the thread after recent activity
   */
  default_auto_archive_duration?: ThreadAutoArchiveDuration;
  /**
   * The set of tags that can be used in a thread-only channel
   */
  available_tags: APIGuildForumTag[];
  /**
   * The initial `rate_limit_per_user` to set on newly created threads.
   * This field is copied to the thread at creation time and does not live update
   */
  default_thread_rate_limit_per_user?: number;
  /**
   * The emoji to show in the add reaction button on a thread in a thread-only channel
   */
  default_reaction_emoji: APIGuildForumDefaultReactionEmoji | null;
  /**
   * The default sort order type used to order posts in a thread-only channel
   */
  default_sort_order: SortOrderType | null;
}
interface APIGuildForumChannel extends APIThreadOnlyChannel<ChannelType.GuildForum> {
  /**
   * The default layout type used to display posts in a forum channel
   *
   * @defaultValue `ForumLayoutType.NotSet` which indicates a layout view has not been set by a channel admin
   */
  default_forum_layout: ForumLayoutType;
}
type APIGuildMediaChannel = APIThreadOnlyChannel<ChannelType.GuildMedia>;
/**
 * @see {@link https://discord.com/developers/docs/resources/channel#channel-object-channel-structure}
 */
type APIChannel = APIAnnouncementThreadChannel | APIDMChannel | APIGroupDMChannel | APIGuildCategoryChannel | APIGuildForumChannel | APIGuildMediaChannel | APIGuildStageVoiceChannel | APIGuildVoiceChannel | APINewsChannel | APIPrivateThreadChannel | APIPublicThreadChannel | APITextChannel;
/**
 * @see {@link https://discord.com/developers/docs/resources/channel#channel-object-channel-types}
 */
declare enum ChannelType {
  /**
   * A text channel within a guild
   */
  GuildText = 0,
  /**
   * A direct message between users
   */
  DM = 1,
  /**
   * A voice channel within a guild
   */
  GuildVoice = 2,
  /**
   * A direct message between multiple users
   */
  GroupDM = 3,
  /**
   * An organizational category that contains up to 50 channels
   *
   * @see {@link https://support.discord.com/hc/articles/115001580171}
   */
  GuildCategory = 4,
  /**
   * A channel that users can follow and crosspost into their own guild
   *
   * @see {@link https://support.discord.com/hc/articles/360032008192}
   */
  GuildAnnouncement = 5,
  /**
   * A temporary sub-channel within a Guild Announcement channel
   */
  AnnouncementThread = 10,
  /**
   * A temporary sub-channel within a Guild Text or Guild Forum channel
   */
  PublicThread = 11,
  /**
   * A temporary sub-channel within a Guild Text channel that is only viewable by those invited and those with the Manage Threads permission
   */
  PrivateThread = 12,
  /**
   * A voice channel for hosting events with an audience
   *
   * @see {@link https://support.discord.com/hc/articles/1500005513722}
   */
  GuildStageVoice = 13,
  /**
   * The channel in a Student Hub containing the listed servers
   *
   * @see {@link https://support.discord.com/hc/articles/4406046651927}
   */
  GuildDirectory = 14,
  /**
   * A channel that can only contain threads
   */
  GuildForum = 15,
  /**
   * A channel like forum channels but contains media for server subscriptions
   *
   * @see {@link https://creator-support.discord.com/hc/articles/14346342766743}
   */
  GuildMedia = 16,
  /**
   * A channel that users can follow and crosspost into their own guild
   *
   * @deprecated This is the old name for {@link ChannelType.GuildAnnouncement}
   * @see {@link https://support.discord.com/hc/articles/360032008192}
   */
  GuildNews = 5,
  /**
   * A temporary sub-channel within a Guild Announcement channel
   *
   * @deprecated This is the old name for {@link ChannelType.AnnouncementThread}
   */
  GuildNewsThread = 10,
  /**
   * A temporary sub-channel within a Guild Text channel
   *
   * @deprecated This is the old name for {@link ChannelType.PublicThread}
   */
  GuildPublicThread = 11,
  /**
   * A temporary sub-channel within a Guild Text channel that is only viewable by those invited and those with the Manage Threads permission
   *
   * @deprecated This is the old name for {@link ChannelType.PrivateThread}
   */
  GuildPrivateThread = 12
}
declare enum VideoQualityMode {
  /**
   * Discord chooses the quality for optimal performance
   */
  Auto = 1,
  /**
   * 720p
   */
  Full = 2
}
/**
 * @see {@link https://discord.com/developers/docs/resources/channel#overwrite-object-overwrite-structure}
 */
interface APIOverwrite {
  /**
   * Role or user id
   */
  id: Snowflake;
  /**
   * Either 0 (role) or 1 (member)
   */
  type: OverwriteType;
  /**
   * Permission bit set
   *
   * @see {@link https://discord.com/developers/docs/topics/permissions#permissions-bitwise-permission-flags}
   * @see {@link https://en.wikipedia.org/wiki/Bit_field}
   */
  allow: Permissions;
  /**
   * Permission bit set
   *
   * @see {@link https://discord.com/developers/docs/topics/permissions#permissions-bitwise-permission-flags}
   * @see {@link https://en.wikipedia.org/wiki/Bit_field}
   */
  deny: Permissions;
}
declare enum OverwriteType {
  Role = 0,
  Member = 1
}
/**
 * @see {@link https://discord.com/developers/docs/resources/channel#thread-metadata-object-thread-metadata-structure}
 */
interface APIThreadMetadata {
  /**
   * Whether the thread is archived
   */
  archived: boolean;
  /**
   * Duration in minutes to automatically archive the thread after recent activity, can be set to: 60, 1440, 4320, 10080
   */
  auto_archive_duration: ThreadAutoArchiveDuration;
  /**
   * An ISO8601 timestamp when the thread's archive status was last changed, used for calculating recent activity
   */
  archive_timestamp: string;
  /**
   * Whether the thread is locked; when a thread is locked, only users with `MANAGE_THREADS` can unarchive it
   */
  locked: boolean;
  /**
   * Whether non-moderators can add other non-moderators to the thread; only available on private threads
   */
  invitable?: boolean;
  /**
   * Timestamp when the thread was created; only populated for threads created after 2022-01-09
   */
  create_timestamp?: string;
}
declare enum ThreadAutoArchiveDuration {
  OneHour = 60,
  OneDay = 1440,
  ThreeDays = 4320,
  OneWeek = 10080
}
/**
 * @see {@link https://discord.com/developers/docs/resources/channel#thread-member-object-thread-member-structure}
 */
interface APIThreadMember {
  /**
   * The id of the thread
   *
   * **This field is omitted on the member sent within each thread in the `GUILD_CREATE` event**
   */
  id?: Snowflake;
  /**
   * The id of the member
   *
   * **This field is omitted on the member sent within each thread in the `GUILD_CREATE` event**
   */
  user_id?: Snowflake;
  /**
   * An ISO8601 timestamp for when the member last joined
   */
  join_timestamp: string;
  /**
   * Member flags combined as a bitfield
   *
   * @see {@link https://en.wikipedia.org/wiki/Bit_field}
   */
  flags: ThreadMemberFlags;
  /**
   * Additional information about the user
   *
   * **This field is omitted on the member sent within each thread in the `GUILD_CREATE` event**
   *
   * **This field is only present when `with_member` is set to true when calling `List Thread Members` or `Get Thread Member`**
   */
  member?: APIGuildMember;
}
declare enum ThreadMemberFlags {
  /**
   * @unstable This thread member flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  HasInteracted = 1,
  /**
   * @unstable This thread member flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  AllMessages = 2,
  /**
   * @unstable This thread member flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  OnlyMentions = 4,
  /**
   * @unstable This thread member flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  NoMessages = 8
}
/**
 * @see {@link https://discord.com/developers/docs/resources/channel#channel-object-channel-flags}
 */
declare enum ChannelFlags {
  /**
   * @unstable This channel flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  GuildFeedRemoved = 1,
  /**
   * This thread is pinned to the top of its parent forum channel
   */
  Pinned = 2,
  /**
   * @unstable This channel flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  ActiveChannelsRemoved = 4,
  /**
   * Whether a tag is required to be specified when creating a thread in a forum channel.
   * Tags are specified in the `applied_tags` field
   */
  RequireTag = 16,
  /**
   * @unstable This channel flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  IsSpam = 32,
  /**
   * @unstable This channel flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  IsGuildResourceChannel = 128,
  /**
   * @unstable This channel flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  ClydeAI = 256,
  /**
   * @unstable This channel flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  IsScheduledForDeletion = 512,
  /**
   * Whether media download options are hidden.
   */
  HideMediaDownloadOptions = 32768
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/gateway.d.ts
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway#get-gateway}
 */
interface APIGatewayInfo {
  /**
   * The WSS URL that can be used for connecting to the gateway
   */
  url: string;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway#get-gateway-bot}
 */
interface APIGatewayBotInfo extends APIGatewayInfo {
  /**
   * The recommended number of shards to use when connecting
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway#sharding}
   */
  shards: number;
  /**
   * Information on the current session start limit
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway#session-start-limit-object}
   */
  session_start_limit: APIGatewaySessionStartLimit;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway#session-start-limit-object}
 */
interface APIGatewaySessionStartLimit {
  /**
   * The total number of session starts the current user is allowed
   */
  total: number;
  /**
   * The remaining number of session starts the current user is allowed
   */
  remaining: number;
  /**
   * The number of milliseconds after which the limit resets
   */
  reset_after: number;
  /**
   * The number of identify requests allowed per 5 seconds
   */
  max_concurrency: number;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#update-presence}
 */
interface GatewayGuildMembersChunkPresence {
  /**
   * The user presence is being updated for
   *
   * **The user object within this event can be partial, the only field which must be sent is the `id` field,
   * everything else is optional.**
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  user: Partial<APIUser> & Pick<APIUser, 'id'>;
  /**
   * Either "idle", "dnd", "online", or "offline"
   */
  status?: PresenceUpdateReceiveStatus;
  /**
   * User's current activities
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object}
   */
  activities?: GatewayActivity[];
  /**
   * User's platform-dependent status
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#client-status-object}
   */
  client_status?: GatewayPresenceClientStatus;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#presence-update-presence-update-event-fields}
 */
interface GatewayPresenceUpdate extends GatewayGuildMembersChunkPresence {
  /**
   * ID of the guild
   */
  guild_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#update-presence-status-types}
 */
declare enum PresenceUpdateStatus {
  Online = "online",
  DoNotDisturb = "dnd",
  Idle = "idle",
  /**
   * Invisible and shown as offline
   */
  Invisible = "invisible",
  Offline = "offline"
}
type PresenceUpdateReceiveStatus = Exclude<PresenceUpdateStatus, PresenceUpdateStatus.Invisible>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#client-status-object}
 */
interface GatewayPresenceClientStatus {
  /**
   * The user's status set for an active desktop (Windows, Linux, Mac) application session
   */
  desktop?: PresenceUpdateReceiveStatus;
  /**
   * The user's status set for an active mobile (iOS, Android) application session
   */
  mobile?: PresenceUpdateReceiveStatus;
  /**
   * The user's status set for an active web (browser, bot account) application session
   */
  web?: PresenceUpdateReceiveStatus;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-structure}
 */
interface GatewayActivity {
  /**
   * The activity's id
   *
   * @unstable
   */
  id: string;
  /**
   * The activity's name
   */
  name: string;
  /**
   * Activity type
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-types}
   */
  type: ActivityType;
  /**
   * Stream url, is validated when type is `1`
   */
  url?: string | null;
  /**
   * Unix timestamp of when the activity was added to the user's session
   */
  created_at: number;
  /**
   * Unix timestamps for start and/or end of the game
   */
  timestamps?: GatewayActivityTimestamps;
  /**
   * The Spotify song id
   *
   * @unstable
   */
  sync_id?: string;
  /**
   * The platform this activity is being done on
   *
   * @unstable You can use {@link ActivityPlatform} as a stepping stone, but this might be inaccurate
   */
  platform?: string;
  /**
   * Application id for the game
   */
  application_id?: Snowflake;
  /**
   * Controls which field is displayed in the user's status text in the member list
   *
   * @see {@link https://discord.com/developers/docs/events/gateway-events#activity-object-status-display-types}
   */
  status_display_type?: StatusDisplayType | null;
  /**
   * What the player is currently doing
   */
  details?: string | null;
  /**
   * URL that is linked when clicking on the details text
   */
  details_url?: string | null;
  /**
   * The user's current party status, or the text used for a custom status
   */
  state?: string | null;
  /**
   * URL that is linked when clicking on the state text
   */
  state_url?: string | null;
  /**
   * The emoji used for a custom status
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-emoji}
   */
  emoji?: GatewayActivityEmoji;
  /**
   * @unstable
   */
  session_id?: string;
  /**
   * Information for the current party of the player
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-party}
   */
  party?: GatewayActivityParty;
  /**
   * Images for the presence and their hover texts
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-assets}
   */
  assets?: GatewayActivityAssets;
  /**
   * Secrets for Rich Presence joining and spectating
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-secrets}
   */
  secrets?: GatewayActivitySecrets;
  /**
   * Whether or not the activity is an instanced game session
   */
  instance?: boolean;
  /**
   * Activity flags `OR`d together, describes what the payload includes
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-flags}
   * @see {@link https://en.wikipedia.org/wiki/Bit_field}
   */
  flags?: ActivityFlags;
  /**
   * The custom buttons shown in the Rich Presence (max 2)
   */
  buttons?: GatewayActivityButton[] | string[];
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-types}
 */
declare enum ActivityType {
  /**
   * Playing \{game\}
   */
  Playing = 0,
  /**
   * Streaming \{details\}
   */
  Streaming = 1,
  /**
   * Listening to \{name\}
   */
  Listening = 2,
  /**
   * Watching \{details\}
   */
  Watching = 3,
  /**
   * \{emoji\} \{state\}
   */
  Custom = 4,
  /**
   * Competing in \{name\}
   */
  Competing = 5
}
/**
 * Controls which field is used in the user's status message
 *
 * @see {@link https://discord.com/developers/docs/events/gateway-events#activity-object-status-display-types}
 */
declare enum StatusDisplayType {
  /**
   * Playing \{name\}
   */
  Name = 0,
  /**
   * Playing \{state\}
   */
  State = 1,
  /**
   * Playing \{details\}
   */
  Details = 2
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-timestamps}
 */
interface GatewayActivityTimestamps {
  /**
   * Unix time (in milliseconds) of when the activity started
   */
  start?: number;
  /**
   * Unix time (in milliseconds) of when the activity ends
   */
  end?: number;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-emoji}
 */
type GatewayActivityEmoji = Partial<Pick<APIEmoji, 'animated' | 'id'>> & Pick<APIEmoji, 'name'>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-party}
 */
interface GatewayActivityParty {
  /**
   * The id of the party
   */
  id?: string;
  /**
   * Used to show the party's current and maximum size
   */
  size?: [current_size: number, max_size: number];
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-assets}
 */
interface GatewayActivityAssets {
  /**
   * @see {@link https://discord.com/developers/docs/events/gateway-events#activity-object-activity-asset-image}
   */
  large_image?: string;
  /**
   * Text displayed when hovering over the large image of the activity
   */
  large_text?: string;
  /**
   * URL that is opened when clicking on the large image
   */
  large_url?: string;
  /**
   * @see {@link https://discord.com/developers/docs/events/gateway-events#activity-object-activity-asset-image}
   */
  small_image?: string;
  /**
   * Text displayed when hovering over the small image of the activity
   */
  small_text?: string;
  /**
   * URL that is opened when clicking on the small image
   */
  small_url?: string;
  /**
   * Displayed as a banner on a Game Invite.
   *
   * @see {@link https://discord.com/developers/docs/events/gateway-events#activity-object-activity-asset-image | Activity Asset Image}
   * @see {@link https://discord.com/developers/docs/discord-social-sdk/development-guides/managing-game-invites | Game Invite}
   */
  invite_cover_image?: string;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-secrets}
 */
interface GatewayActivitySecrets {
  /**
   * The secret for joining a party
   */
  join?: string;
  /**
   * The secret for spectating a game
   */
  spectate?: string;
  /**
   * The secret for a specific instance of a match
   */
  match?: string;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-flags}
 */
declare enum ActivityFlags {
  Instance = 1,
  Join = 2,
  Spectate = 4,
  JoinRequest = 8,
  Sync = 16,
  Play = 32,
  PartyPrivacyFriends = 64,
  PartyPrivacyVoiceChannel = 128,
  Embedded = 256
}
interface GatewayActivityButton {
  /**
   * The text shown on the button (1-32 characters)
   */
  label: string;
  /**
   * The url opened when clicking the button (1-512 characters)
   */
  url: string;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-list-sync-thread-list-sync-event-fields}
 */
interface GatewayThreadListSync {
  /**
   * ID of the guild
   */
  guild_id: Snowflake;
  /**
   * The ids of all the parent channels whose threads are being synced, otherwise the entire guild
   */
  channel_ids?: Snowflake[];
  /**
   * Array of the synced threads
   */
  threads: APIThreadChannel[];
  /**
   * The member objects for the client user in each joined thread that was synced
   */
  members: APIThreadMember[];
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-members-update-thread-members-update-event-fields}
 */
interface GatewayThreadMembersUpdate {
  /**
   * The id of the thread for which members are being synced
   */
  id: Snowflake;
  /**
   * The id of the guild that the thread is in
   */
  guild_id: Snowflake;
  /**
   * The approximate member count of the thread, does not count above 50 even if there are more members
   */
  member_count: number;
  /**
   * The members that were added to the thread
   */
  added_members?: APIThreadMember[];
  /**
   * The ids of the members that were removed from the thread
   */
  removed_member_ids?: Snowflake[];
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/oauth2.d.ts
/**
 * Types extracted from https://discord.com/developers/docs/topics/oauth2
 */
declare enum OAuth2Scopes {
  /**
   * For oauth2 bots, this puts the bot in the user's selected guild by default
   */
  Bot = "bot",
  /**
   * Allows {@link https://discord.com/developers/docs/resources/user#get-user-connections | `/users/@me/connections`}
   * to return linked third-party accounts
   *
   * @see {@link https://discord.com/developers/docs/resources/user#get-user-connections}
   */
  Connections = "connections",
  /**
   * Allows your app to see information about the user's DMs and group DMs - requires Discord approval
   */
  DMChannelsRead = "dm_channels.read",
  /**
   * Enables {@link https://discord.com/developers/docs/resources/user#get-current-user | `/users/@me`} to return an `email`
   *
   * @see {@link https://discord.com/developers/docs/resources/user#get-current-user}
   */
  Email = "email",
  /**
   * Allows {@link https://discord.com/developers/docs/resources/user#get-current-user | `/users/@me`} without `email`
   *
   * @see {@link https://discord.com/developers/docs/resources/user#get-current-user}
   */
  Identify = "identify",
  /**
   * Allows {@link https://discord.com/developers/docs/resources/user#get-current-user-guilds | `/users/@me/guilds`}
   * to return basic information about all of a user's guilds
   *
   * @see {@link https://discord.com/developers/docs/resources/user#get-current-user-guilds}
   */
  Guilds = "guilds",
  /**
   * Allows {@link https://discord.com/developers/docs/resources/guild#add-guild-member | `/guilds/[guild.id]/members/[user.id]`}
   * to be used for joining users to a guild
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#add-guild-member}
   */
  GuildsJoin = "guilds.join",
  /**
   * Allows /users/\@me/guilds/\{guild.id\}/member to return a user's member information in a guild
   *
   * @see {@link https://discord.com/developers/docs/resources/user#get-current-user-guild-member}
   */
  GuildsMembersRead = "guilds.members.read",
  /**
   * Allows your app to join users to a group dm
   *
   * @see {@link https://discord.com/developers/docs/resources/channel#group-dm-add-recipient}
   */
  GroupDMJoins = "gdm.join",
  /**
   * For local rpc server api access, this allows you to read messages from all client channels
   * (otherwise restricted to channels/guilds your app creates)
   */
  MessagesRead = "messages.read",
  /**
   * Allows your app to update a user's connection and metadata for the app
   */
  RoleConnectionsWrite = "role_connections.write",
  /**
   * For local rpc server access, this allows you to control a user's local Discord client - requires Discord approval
   */
  RPC = "rpc",
  /**
   * For local rpc server access, this allows you to update a user's activity - requires Discord approval
   */
  RPCActivitiesWrite = "rpc.activities.write",
  /**
   * For local rpc server access, this allows you to read a user's voice settings and listen for voice events - requires Discord approval
   */
  RPCVoiceRead = "rpc.voice.read",
  /**
   * For local rpc server access, this allows you to update a user's voice settings - requires Discord approval
   */
  RPCVoiceWrite = "rpc.voice.write",
  /**
   * For local rpc server api access, this allows you to receive notifications pushed out to the user - requires Discord approval
   */
  RPCNotificationsRead = "rpc.notifications.read",
  /**
   * This generates a webhook that is returned in the oauth token response for authorization code grants
   */
  WebhookIncoming = "webhook.incoming",
  /**
   * Allows your app to connect to voice on user's behalf and see all the voice members - requires Discord approval
   */
  Voice = "voice",
  /**
   * Allows your app to upload/update builds for a user's applications - requires Discord approval
   */
  ApplicationsBuildsUpload = "applications.builds.upload",
  /**
   * Allows your app to read build data for a user's applications
   */
  ApplicationsBuildsRead = "applications.builds.read",
  /**
   * Allows your app to read and update store data (SKUs, store listings, achievements, etc.) for a user's applications
   */
  ApplicationsStoreUpdate = "applications.store.update",
  /**
   * Allows your app to read entitlements for a user's applications
   */
  ApplicationsEntitlements = "applications.entitlements",
  /**
   * Allows your app to know a user's friends and implicit relationships - requires Discord approval
   */
  RelationshipsRead = "relationships.read",
  /**
   * Allows your app to fetch data from a user's "Now Playing/Recently Played" list - requires Discord approval
   */
  ActivitiesRead = "activities.read",
  /**
   * Allows your app to update a user's activity - requires Discord approval (NOT REQUIRED FOR GAMESDK ACTIVITY MANAGER)
   *
   * @see {@link https://discord.com/developers/docs/game-sdk/activities}
   */
  ActivitiesWrite = "activities.write",
  /**
   * Allows your app to use Application Commands in a guild
   *
   * @see {@link https://discord.com/developers/docs/interactions/application-commands}
   */
  ApplicationsCommands = "applications.commands",
  /**
   * Allows your app to update its Application Commands via this bearer token - client credentials grant only
   *
   * @see {@link https://discord.com/developers/docs/interactions/application-commands}
   */
  ApplicationsCommandsUpdate = "applications.commands.update",
  /**
   * Allows your app to update permissions for its commands using a Bearer token - client credentials grant only
   *
   * @see {@link https://discord.com/developers/docs/interactions/application-commands}
   */
  ApplicationCommandsPermissionsUpdate = "applications.commands.permissions.update"
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/sticker.d.ts
/**
 * @see {@link https://discord.com/developers/docs/resources/sticker#sticker-object}
 */
interface APISticker {
  /**
   * ID of the sticker
   */
  id: Snowflake;
  /**
   * For standard stickers, ID of the pack the sticker is from
   */
  pack_id?: Snowflake;
  /**
   * Name of the sticker
   */
  name: string;
  /**
   * Description of the sticker
   */
  description: string | null;
  /**
   * For guild stickers, the Discord name of a unicode emoji representing the sticker's expression. for standard stickers, a comma-separated list of related expressions.
   */
  tags: string;
  /**
   * Previously the sticker asset hash, now an empty string
   *
   * @deprecated This field is no longer documented by Discord and will be removed in v11
   * @unstable This field is no longer documented by Discord and will be removed in v11
   */
  asset?: '';
  /**
   * Type of sticker
   *
   * @see {@link https://discord.com/developers/docs/resources/sticker#sticker-object-sticker-types}
   */
  type: StickerType;
  /**
   * Type of sticker format
   *
   * @see {@link https://discord.com/developers/docs/resources/sticker#sticker-object-sticker-format-types}
   */
  format_type: StickerFormatType;
  /**
   * Whether this guild sticker can be used, may be false due to loss of Server Boosts
   */
  available?: boolean;
  /**
   * ID of the guild that owns this sticker
   */
  guild_id?: Snowflake;
  /**
   * The user that uploaded the guild sticker
   */
  user?: APIUser;
  /**
   * The standard sticker's sort order within its pack
   */
  sort_value?: number;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/sticker#sticker-object-sticker-types}
 */
declare enum StickerType {
  /**
   * An official sticker in a pack
   */
  Standard = 1,
  /**
   * A sticker uploaded to a guild for the guild's members
   */
  Guild = 2
}
/**
 * @see {@link https://discord.com/developers/docs/resources/sticker#sticker-object-sticker-format-types}
 */
declare enum StickerFormatType {
  PNG = 1,
  APNG = 2,
  Lottie = 3,
  GIF = 4
}
/**
 * @see {@link https://discord.com/developers/docs/resources/sticker#sticker-item-object}
 */
type APIStickerItem = Pick<APISticker, 'format_type' | 'id' | 'name'>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/guild.d.ts
interface APIBaseGuild {
  /**
   * Guild id
   */
  id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#unavailable-guild-object}
 */
interface APIUnavailableGuild extends APIBaseGuild {
  /**
   * `true` if this guild is unavailable due to an outage
   */
  unavailable: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-guild-structure}
 */
interface APIPartialGuild extends APIBaseGuild {
  /**
   * Guild name (2-100 characters, excluding trailing and leading whitespace)
   */
  name: string;
  /**
   * Icon hash
   *
   * @see {@link https://discord.com/developers/docs/reference#image-formatting}
   */
  icon: string | null;
  /**
   * Splash hash
   *
   * @see {@link https://discord.com/developers/docs/reference#image-formatting}
   */
  splash: string | null;
  /**
   * Banner hash
   *
   * @see {@link https://discord.com/developers/docs/reference#image-formatting}
   */
  banner?: string | null;
  /**
   * The description for the guild
   */
  description?: string | null;
  /**
   * Enabled guild features
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-guild-features}
   */
  features?: GuildFeature[];
  /**
   * Verification level required for the guild
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-verification-level}
   */
  verification_level?: GuildVerificationLevel;
  /**
   * The vanity url code for the guild
   */
  vanity_url_code?: string | null;
  /**
   * The welcome screen of a Community guild, shown to new members
   *
   * Returned in the invite object
   */
  welcome_screen?: APIGuildWelcomeScreen;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-guild-structure}
 */
interface APIGuild extends APIPartialGuild {
  /**
   * Icon hash, returned when in the template object
   *
   * @see {@link https://discord.com/developers/docs/reference#image-formatting}
   */
  icon_hash?: string | null;
  /**
   * Discovery splash hash; only present for guilds with the "DISCOVERABLE" feature
   *
   * @see {@link https://discord.com/developers/docs/reference#image-formatting}
   */
  discovery_splash: string | null;
  /**
   * `true` if the user is the owner of the guild
   *
   * **This field is only received from https://discord.com/developers/docs/resources/user#get-current-user-guilds**
   */
  owner?: boolean;
  /**
   * ID of owner
   */
  owner_id: Snowflake;
  /**
   * Total permissions for the user in the guild (excludes overrides)
   *
   * **This field is only received from https://discord.com/developers/docs/resources/user#get-current-user-guilds**
   *
   * @see {@link https://en.wikipedia.org/wiki/Bit_field}
   */
  permissions?: Permissions;
  /**
   * Voice region id for the guild
   *
   * @see {@link https://discord.com/developers/docs/resources/voice#voice-region-object}
   * @deprecated This field has been deprecated in favor of `rtc_region` on the channel.
   */
  region?: string | null;
  /**
   * ID of afk channel
   */
  afk_channel_id: Snowflake | null;
  /**
   * afk timeout in seconds, can be set to: `60`, `300`, `900`, `1800`, `3600`
   */
  afk_timeout: 1800 | 3600 | 60 | 300 | 900;
  /**
   * `true` if the guild widget is enabled
   */
  widget_enabled?: boolean;
  /**
   * The channel id that the widget will generate an invite to, or `null` if set to no invite
   */
  widget_channel_id?: Snowflake | null;
  /**
   * Verification level required for the guild
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-verification-level}
   */
  verification_level: GuildVerificationLevel;
  /**
   * Default message notifications level
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-default-message-notification-level}
   */
  default_message_notifications: GuildDefaultMessageNotifications;
  /**
   * Explicit content filter level
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-explicit-content-filter-level}
   */
  explicit_content_filter: GuildExplicitContentFilter;
  /**
   * Roles in the guild
   *
   * @see {@link https://discord.com/developers/docs/topics/permissions#role-object}
   */
  roles: APIRole[];
  /**
   * Custom guild emojis
   *
   * @see {@link https://discord.com/developers/docs/resources/emoji#emoji-object}
   */
  emojis: APIEmoji[];
  /**
   * Enabled guild features
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-guild-features}
   */
  features: GuildFeature[];
  /**
   * Required MFA level for the guild
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-mfa-level}
   */
  mfa_level: GuildMFALevel;
  /**
   * Application id of the guild creator if it is bot-created
   */
  application_id: Snowflake | null;
  /**
   * The id of the channel where guild notices such as welcome messages and boost events are posted
   */
  system_channel_id: Snowflake | null;
  /**
   * System channel flags
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-system-channel-flags}
   */
  system_channel_flags: GuildSystemChannelFlags;
  /**
   * The id of the channel where Community guilds can display rules and/or guidelines
   */
  rules_channel_id: Snowflake | null;
  /**
   * The maximum number of presences for the guild (`null` is always returned, apart from the largest of guilds)
   */
  max_presences?: number | null;
  /**
   * The maximum number of members for the guild
   */
  max_members?: number;
  /**
   * The vanity url code for the guild
   */
  vanity_url_code: string | null;
  /**
   * The description for the guild
   */
  description: string | null;
  /**
   * Banner hash
   *
   * @see {@link https://discord.com/developers/docs/reference#image-formatting}
   */
  banner: string | null;
  /**
   * Premium tier (Server Boost level)
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-premium-tier}
   */
  premium_tier: GuildPremiumTier;
  /**
   * The number of boosts this guild currently has
   */
  premium_subscription_count?: number;
  /**
   * The preferred locale of a Community guild; used in guild discovery and notices from Discord
   *
   * @defaultValue `"en-US"`
   */
  preferred_locale: Locale;
  /**
   * The id of the channel where admins and moderators of Community guilds receive notices from Discord
   */
  public_updates_channel_id: Snowflake | null;
  /**
   * The maximum amount of users in a video channel
   */
  max_video_channel_users?: number;
  /**
   * The maximum amount of users in a stage video channel
   */
  max_stage_video_channel_users?: number;
  /**
   * Approximate number of members in this guild,
   * returned from the `GET /guilds/<id>` and `/users/@me/guilds` (OAuth2) endpoints when `with_counts` is `true`
   */
  approximate_member_count?: number;
  /**
   * Approximate number of non-offline members in this guild,
   * returned from the `GET /guilds/<id>` and `/users/@me/guilds` (OAuth2) endpoints when `with_counts` is `true`
   */
  approximate_presence_count?: number;
  /**
   * The nsfw level of the guild
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-guild-nsfw-level}
   */
  nsfw_level: GuildNSFWLevel;
  /**
   * Custom guild stickers
   *
   * @see {@link https://discord.com/developers/docs/resources/sticker#sticker-object}
   */
  stickers?: APISticker[];
  /**
   * Whether the guild has the boost progress bar enabled.
   */
  premium_progress_bar_enabled: boolean;
  /**
   * The type of Student Hub the guild is
   */
  hub_type: GuildHubType | null;
  /**
   * The id of the channel where admins and moderators of Community guilds receive safety alerts from Discord
   */
  safety_alerts_channel_id: Snowflake | null;
  /**
   * The incidents data for this guild
   */
  incidents_data: APIIncidentsData | null;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-guild-structure}
 */
interface APIPartialInteractionGuild extends Pick<APIGuild, 'features' | 'id'> {
  /**
   * The preferred locale of a Community guild; used in guild discovery and notices from Discord
   *
   * @unstable https://github.com/discord/discord-api-docs/issues/6938
   * @defaultValue `"en-US"`
   */
  locale: Locale;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-default-message-notification-level}
 */
declare enum GuildDefaultMessageNotifications {
  AllMessages = 0,
  OnlyMentions = 1
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-explicit-content-filter-level}
 */
declare enum GuildExplicitContentFilter {
  Disabled = 0,
  MembersWithoutRoles = 1,
  AllMembers = 2
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-mfa-level}
 */
declare enum GuildMFALevel {
  None = 0,
  Elevated = 1
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-guild-nsfw-level}
 */
declare enum GuildNSFWLevel {
  Default = 0,
  Explicit = 1,
  Safe = 2,
  AgeRestricted = 3
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-verification-level}
 */
declare enum GuildVerificationLevel {
  /**
   * Unrestricted
   */
  None = 0,
  /**
   * Must have verified email on account
   */
  Low = 1,
  /**
   * Must be registered on Discord for longer than 5 minutes
   */
  Medium = 2,
  /**
   * Must be a member of the guild for longer than 10 minutes
   */
  High = 3,
  /**
   * Must have a verified phone number
   */
  VeryHigh = 4
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-premium-tier}
 */
declare enum GuildPremiumTier {
  None = 0,
  Tier1 = 1,
  Tier2 = 2,
  Tier3 = 3
}
declare enum GuildHubType {
  Default = 0,
  HighSchool = 1,
  College = 2
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-system-channel-flags}
 */
declare enum GuildSystemChannelFlags {
  /**
   * Suppress member join notifications
   */
  SuppressJoinNotifications = 1,
  /**
   * Suppress server boost notifications
   */
  SuppressPremiumSubscriptions = 2,
  /**
   * Suppress server setup tips
   */
  SuppressGuildReminderNotifications = 4,
  /**
   * Hide member join sticker reply buttons
   */
  SuppressJoinNotificationReplies = 8,
  /**
   * Suppress role subscription purchase and renewal notifications
   */
  SuppressRoleSubscriptionPurchaseNotifications = 16,
  /**
   * Hide role subscription sticker reply buttons
   */
  SuppressRoleSubscriptionPurchaseNotificationReplies = 32
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-object-guild-features}
 */
declare enum GuildFeature {
  /**
   * Guild has access to set an animated guild banner image
   */
  AnimatedBanner = "ANIMATED_BANNER",
  /**
   * Guild has access to set an animated guild icon
   */
  AnimatedIcon = "ANIMATED_ICON",
  /**
   * Guild is using the old permissions configuration behavior
   *
   * @see {@link https://discord.com/developers/docs/change-log#upcoming-application-command-permission-changes}
   */
  ApplicationCommandPermissionsV2 = "APPLICATION_COMMAND_PERMISSIONS_V2",
  /**
   * Guild has set up auto moderation rules
   */
  AutoModeration = "AUTO_MODERATION",
  /**
   * Guild has access to set a guild banner image
   */
  Banner = "BANNER",
  /**
   * Guild can enable welcome screen, Membership Screening and discovery, and receives community updates
   */
  Community = "COMMUNITY",
  /**
   * Guild has enabled monetization
   */
  CreatorMonetizableProvisional = "CREATOR_MONETIZABLE_PROVISIONAL",
  /**
   * Guild has enabled the role subscription promo page
   */
  CreatorStorePage = "CREATOR_STORE_PAGE",
  /**
   * Guild has been set as a support server on the App Directory
   */
  DeveloperSupportServer = "DEVELOPER_SUPPORT_SERVER",
  /**
   * Guild is able to be discovered in the directory
   */
  Discoverable = "DISCOVERABLE",
  /**
   * Guild is able to be featured in the directory
   */
  Featurable = "FEATURABLE",
  /**
   * Guild is listed in a directory channel
   */
  HasDirectoryEntry = "HAS_DIRECTORY_ENTRY",
  /**
   * Guild is a Student Hub
   *
   * @see {@link https://support.discord.com/hc/articles/4406046651927}
   * @unstable This feature is currently not documented by Discord, but has known value
   */
  Hub = "HUB",
  /**
   * Guild has disabled invite usage, preventing users from joining
   */
  InvitesDisabled = "INVITES_DISABLED",
  /**
   * Guild has access to set an invite splash background
   */
  InviteSplash = "INVITE_SPLASH",
  /**
   * Guild is in a Student Hub
   *
   * @see {@link https://support.discord.com/hc/articles/4406046651927}
   * @unstable This feature is currently not documented by Discord, but has known value
   */
  LinkedToHub = "LINKED_TO_HUB",
  /**
   * Guild has enabled Membership Screening
   */
  MemberVerificationGateEnabled = "MEMBER_VERIFICATION_GATE_ENABLED",
  /**
   * Guild has increased custom soundboard sound slots
   */
  MoreSoundboard = "MORE_SOUNDBOARD",
  /**
   * Guild has enabled monetization
   *
   * @unstable This feature is no longer documented by Discord
   */
  MonetizationEnabled = "MONETIZATION_ENABLED",
  /**
   * Guild has increased custom sticker slots
   */
  MoreStickers = "MORE_STICKERS",
  /**
   * Guild has access to create news channels
   */
  News = "NEWS",
  /**
   * Guild is partnered
   */
  Partnered = "PARTNERED",
  /**
   * Guild can be previewed before joining via Membership Screening or the directory
   */
  PreviewEnabled = "PREVIEW_ENABLED",
  /**
   * Guild has access to create private threads
   */
  PrivateThreads = "PRIVATE_THREADS",
  /**
   * Guild has disabled alerts for join raids in the configured safety alerts channel
   */
  RaidAlertsDisabled = "RAID_ALERTS_DISABLED",
  RelayEnabled = "RELAY_ENABLED",
  /**
   * Guild is able to set role icons
   */
  RoleIcons = "ROLE_ICONS",
  /**
   * Guild has role subscriptions that can be purchased
   */
  RoleSubscriptionsAvailableForPurchase = "ROLE_SUBSCRIPTIONS_AVAILABLE_FOR_PURCHASE",
  /**
   * Guild has enabled role subscriptions
   */
  RoleSubscriptionsEnabled = "ROLE_SUBSCRIPTIONS_ENABLED",
  /**
   * Guild has created soundboard sounds
   */
  Soundboard = "SOUNDBOARD",
  /**
   * Guild has enabled ticketed events
   */
  TicketedEventsEnabled = "TICKETED_EVENTS_ENABLED",
  /**
   * Guild has access to set a vanity URL
   */
  VanityURL = "VANITY_URL",
  /**
   * Guild is verified
   */
  Verified = "VERIFIED",
  /**
   * Guild has access to set 384kbps bitrate in voice (previously VIP voice servers)
   */
  VIPRegions = "VIP_REGIONS",
  /**
   * Guild has enabled the welcome screen
   */
  WelcomeScreenEnabled = "WELCOME_SCREEN_ENABLED",
  /**
   * Guild has access to set guild tags
   */
  GuildTags = "GUILD_TAGS",
  /**
   * Guild is able to set gradient colors to roles
   */
  EnhancedRoleColors = "ENHANCED_ROLE_COLORS",
  /**
   * Guild has access to guest invites
   */
  GuestsEnabled = "GUESTS_ENABLED",
  /**
   * Guild has migrated to the new pin messages permission
   *
   * @unstable This feature is currently not documented by Discord, but has known value
   */
  PinPermissionMigrationComplete = "PIN_PERMISSION_MIGRATION_COMPLETE"
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
 */
interface APIBaseGuildMember {
  /**
   * This users guild nickname
   */
  nick?: string | null;
  /**
   * Array of role object ids
   *
   * @see {@link https://discord.com/developers/docs/topics/permissions#role-object}
   */
  roles: Snowflake[];
  /**
   * When the user started boosting the guild
   *
   * @see {@link https://support.discord.com/hc/articles/360028038352}
   */
  premium_since?: string | null;
  /**
   * Whether the user has not yet passed the guild's Membership Screening requirements
   *
   * @remarks If this field is not present, it can be assumed as `false`.
   */
  pending?: boolean;
  /**
   * Timestamp of when the time out will be removed; until then, they cannot interact with the guild
   */
  communication_disabled_until?: string | null;
  /**
   * The data for the member's guild avatar decoration
   *
   * @see {@link https://discord.com/developers/docs/resources/user#avatar-decoration-data-object}
   */
  avatar_decoration_data?: APIAvatarDecorationData | null;
  /**
   * The data for the member's collectibles
   *
   * @see {@link https://discord.com/developers/docs/resources/user#collectibles}
   */
  collectibles?: APICollectibles | null;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
 */
interface APIFlaggedGuildMember {
  /**
   * Guild member flags represented as a bit set
   *
   * @defaultValue `0`
   */
  flags: GuildMemberFlags;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
 */
interface APIGuildMemberJoined {
  /**
   * When the user joined the guild
   */
  joined_at: string | null;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
 */
interface APIGuildMemberAvatar {
  /**
   * The member's guild avatar hash
   */
  avatar?: string | null;
  /**
   * The member's guild banner hash
   */
  banner?: string | null;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
 */
interface APIBaseVoiceGuildMember {
  /**
   * Whether the user is deafened in voice channels
   */
  deaf: boolean;
  /**
   * Whether the user is muted in voice channels
   */
  mute: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
 */
interface APIGuildMemberUser {
  /**
   * The user this guild member represents
   *
   * **This field won't be included in the member object attached to `MESSAGE_CREATE` and `MESSAGE_UPDATE` gateway events.**
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  user: APIUser;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
 */
interface APIGuildMember extends APIBaseGuildMember, APIBaseVoiceGuildMember, APIFlaggedGuildMember, APIGuildMemberAvatar, APIGuildMemberJoined, APIGuildMemberUser {}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object-guild-member-flags}
 */
declare enum GuildMemberFlags {
  /**
   * Member has left and rejoined the guild
   */
  DidRejoin = 1,
  /**
   * Member has completed onboarding
   */
  CompletedOnboarding = 2,
  /**
   * Member is exempt from guild verification requirements
   */
  BypassesVerification = 4,
  /**
   * Member has started onboarding
   */
  StartedOnboarding = 8,
  /**
   * Member is a guest and can only access the voice channel they were invited to
   */
  IsGuest = 16,
  /**
   * Member has started Server Guide new member actions
   */
  StartedHomeActions = 32,
  /**
   * Member has completed Server Guide new member actions
   */
  CompletedHomeActions = 64,
  /**
   * Member's username, display name, or nickname is blocked by AutoMod
   */
  AutomodQuarantinedUsernameOrGuildNickname = 128,
  /**
   * @deprecated
   * {@link https://github.com/discord/discord-api-docs/pull/7113 | discord-api-docs#7113}
   */
  AutomodQuarantinedBio = 256,
  /**
   * Member has dismissed the DM settings upsell
   */
  DmSettingsUpsellAcknowledged = 512,
  /**
   * Member's guild tag is blocked by AutoMod
   */
  AutoModQuarantinedGuildTag = 1024
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#integration-object}
 */
interface APIGuildIntegration {
  /**
   * Integration id
   */
  id: Snowflake;
  /**
   * Integration name
   */
  name: string;
  /**
   * Integration type
   */
  type: APIGuildIntegrationType;
  /**
   * Is this integration enabled
   */
  enabled: boolean;
  /**
   * Is this integration syncing
   *
   * **This field is not provided for `discord` bot integrations.**
   */
  syncing?: boolean;
  /**
   * ID that this integration uses for "subscribers"
   *
   * **This field is not provided for `discord` bot integrations.**
   */
  role_id?: Snowflake;
  /**
   * Whether emoticons should be synced for this integration (`twitch` only currently)
   *
   * **This field is not provided for `discord` bot integrations.**
   */
  enable_emoticons?: boolean;
  /**
   * The behavior of expiring subscribers
   *
   * **This field is not provided for `discord` bot integrations.**
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#integration-object-integration-expire-behaviors}
   */
  expire_behavior?: IntegrationExpireBehavior;
  /**
   * The grace period (in days) before expiring subscribers
   *
   * **This field is not provided for `discord` bot integrations.**
   */
  expire_grace_period?: number;
  /**
   * User for this integration
   *
   * **Some older integrations may not have an attached user.**
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  user?: APIUser;
  /**
   * Integration account information
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#integration-account-object}
   */
  account: APIIntegrationAccount;
  /**
   * When this integration was last synced
   *
   * **This field is not provided for `discord` bot integrations.**
   */
  synced_at?: string;
  /**
   * How many subscribers this integration has
   *
   * **This field is not provided for `discord` bot integrations.**
   */
  subscriber_count?: number;
  /**
   * Has this integration been revoked
   *
   * **This field is not provided for `discord` bot integrations.**
   */
  revoked?: boolean;
  /**
   * The bot/OAuth2 application for discord integrations
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#integration-application-object}
   *
   * **This field is not provided for `discord` bot integrations.**
   */
  application?: APIGuildIntegrationApplication;
  /**
   * The scopes the application has been authorized for
   */
  scopes?: OAuth2Scopes[];
}
type APIGuildIntegrationType = 'discord' | 'guild_subscription' | 'twitch' | 'youtube';
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#integration-object-integration-expire-behaviors}
 */
declare enum IntegrationExpireBehavior {
  RemoveRole = 0,
  Kick = 1
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#integration-account-object}
 */
interface APIIntegrationAccount {
  /**
   * ID of the account
   */
  id: string;
  /**
   * Name of the account
   */
  name: string;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#integration-application-object}
 */
interface APIGuildIntegrationApplication {
  /**
   * The id of the app
   */
  id: Snowflake;
  /**
   * The name of the app
   */
  name: string;
  /**
   * The icon hash of the app
   *
   * @see {@link https://discord.com/developers/docs/reference#image-formatting}
   */
  icon: string | null;
  /**
   * The description of the app
   */
  description: string;
  /**
   * The bot associated with this application
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  bot?: APIUser;
}
interface APIGuildWelcomeScreen {
  /**
   * The welcome screen short message
   */
  description: string | null;
  /**
   * Array of suggested channels
   */
  welcome_channels: APIGuildWelcomeScreenChannel[];
}
interface APIGuildWelcomeScreenChannel {
  /**
   * The channel id that is suggested
   */
  channel_id: Snowflake;
  /**
   * The description shown for the channel
   */
  description: string;
  /**
   * The emoji id of the emoji that is shown on the left of the channel
   */
  emoji_id: Snowflake | null;
  /**
   * The emoji name of the emoji that is shown on the left of the channel
   */
  emoji_name: string | null;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#incidents-data-object}
 */
interface APIIncidentsData {
  /**
   * When invites get enabled again
   */
  invites_disabled_until: string | null;
  /**
   * When direct messages get enabled again
   */
  dms_disabled_until: string | null;
  /**
   * When the dm spam was detected
   */
  dm_spam_detected_at?: string | null;
  /**
   * When the raid was detected
   */
  raid_detected_at?: string | null;
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/poll.d.ts
interface APIBasePoll {
  /**
   * The question of the poll
   */
  question: APIPollMedia;
}
interface APIPollDefaults {
  /**
   * Whether a user can select multiple answers
   *
   * @defaultValue `false`
   */
  allow_multiselect: boolean;
  /**
   * The layout type of the poll
   *
   * @defaultValue `PollLayoutType.Default`
   */
  layout_type: PollLayoutType;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/poll#poll-object-poll-object-structure}
 */
interface APIPoll extends APIBasePoll, APIPollDefaults {
  /**
   * Each of the answers available in the poll, up to 10
   */
  answers: APIPollAnswer[];
  /**
   * The time when the poll ends (IS08601 timestamp)
   */
  expiry: string | null;
  /**
   * The results of the poll
   */
  results?: APIPollResults;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/poll#layout-type}
 */
declare enum PollLayoutType {
  /**
   * The, uhm, default layout type
   */
  Default = 1
}
/**
 * @see {@link https://discord.com/developers/docs/resources/poll#poll-media-object-poll-media-object-structure}
 */
interface APIPollMedia {
  /**
   * The text of the field
   *
   * The maximum length is `300` for the question, and `55` for any answer
   */
  text?: string;
  /**
   * The emoji of the field
   */
  emoji?: APIPartialEmoji;
}
interface APIBasePollAnswer {
  /**
   * The data of the answer
   */
  poll_media: APIPollMedia;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/poll#poll-answer-object-poll-answer-object-structure}
 */
interface APIPollAnswer extends APIBasePollAnswer {
  /**
   * The ID of the answer. Starts at `1` for the first answer and goes up sequentially
   */
  answer_id: number;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/poll#poll-results-object-poll-results-object-structure}
 */
interface APIPollResults {
  /**
   * Whether the votes have been precisely counted
   */
  is_finalized: boolean;
  /**
   * The counts for each answer
   */
  answer_counts: APIPollAnswerCount[];
}
/**
 * @see {@link https://discord.com/developers/docs/resources/poll#poll-results-object-poll-answer-count-object-structure}
 */
interface APIPollAnswerCount {
  /**
   * The `answer_id`
   */
  id: number;
  /**
   * The number of votes for this answer
   */
  count: number;
  /**
   * Whether the current user voted for this answer
   */
  me_voted: boolean;
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/message.d.ts
interface APIMessageMentions {
  /**
   * Users specifically mentioned in the message
   *
   * The `member` field is only present in `MESSAGE_CREATE` and `MESSAGE_UPDATE` events
   * from text-based guild channels
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
   */
  mentions: APIUser[];
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-object-message-structure}
 */
interface APIBaseMessageNoChannel {
  /**
   * ID of the message
   */
  id: Snowflake;
  /**
   * The author of this message (only a valid user in the case where the message is generated by a user or bot user)
   *
   * If the message is generated by a webhook, the author object corresponds to the webhook's id,
   * username, and avatar. You can tell if a message is generated by a webhook by checking for the `webhook_id` property
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  author: APIUser;
  /**
   * Contents of the message
   *
   * The `MESSAGE_CONTENT` privileged gateway intent is required for verified applications to receive a non-empty value from this field
   *
   * In the Discord Developers Portal, you need to enable the toggle of this intent of your application in **Bot \> Privileged Gateway Intents**.
   * You also need to specify the intent bit value (`1 << 15`) if you are connecting to the gateway
   *
   * @see {@link https://support-dev.discord.com/hc/articles/6207308062871}
   */
  content: string;
  /**
   * When this message was sent
   */
  timestamp: string;
  /**
   * When this message was edited (or null if never)
   */
  edited_timestamp: string | null;
  /**
   * Whether this was a TTS message
   */
  tts: boolean;
  /**
   * Whether this message mentions everyone
   */
  mention_everyone: boolean;
  /**
   * Roles specifically mentioned in this message
   *
   * @see {@link https://discord.com/developers/docs/topics/permissions#role-object}
   */
  mention_roles: APIRole['id'][];
  /**
   * Channels specifically mentioned in this message
   *
   * Not all channel mentions in a message will appear in `mention_channels`.
   * - Only textual channels that are visible to everyone in a lurkable guild will ever be included
   * - Only crossposted messages (via Channel Following) currently include `mention_channels` at all
   *
   * If no mentions in the message meet these requirements, this field will not be sent
   *
   * @see {@link https://discord.com/developers/docs/resources/message#channel-mention-object}
   */
  mention_channels?: APIChannelMention[];
  /**
   * Any attached files that are not referenced in embeds or components
   *
   * @see {@link https://discord.com/developers/docs/resources/message#attachment-object-attachment-structure}
   *
   * The `MESSAGE_CONTENT` privileged gateway intent is required for verified applications to receive a non-empty value from this field
   *
   * In the Discord Developers Portal, you need to enable the toggle of this intent of your application in **Bot \> Privileged Gateway Intents**.
   * You also need to specify the intent bit value (`1 << 15`) if you are connecting to the gateway
   * @see {@link https://support-dev.discord.com/hc/articles/6207308062871}
   */
  attachments: APIAttachment[];
  /**
   * Any embedded content
   *
   * @see {@link https://discord.com/developers/docs/resources/message#embed-object}
   *
   * The `MESSAGE_CONTENT` privileged gateway intent is required for verified applications to receive a non-empty value from this field
   *
   * In the Discord Developers Portal, you need to enable the toggle of this intent of your application in **Bot \> Privileged Gateway Intents**.
   * You also need to specify the intent bit value (`1 << 15`) if you are connecting to the gateway
   * @see {@link https://support-dev.discord.com/hc/articles/6207308062871}
   */
  embeds: APIEmbed[];
  /**
   * Reactions to the message
   *
   * @see {@link https://discord.com/developers/docs/resources/message#reaction-object}
   */
  reactions?: APIReaction[];
  /**
   * A nonce that can be used for optimistic message sending (up to 25 characters)
   *
   * **You will not receive this from further fetches. This is received only once from a `MESSAGE_CREATE`
   * event to ensure it got sent**
   */
  nonce?: number | string;
  /**
   * Whether this message is pinned
   */
  pinned: boolean;
  /**
   * If the message is generated by a webhook, this is the webhook's id
   */
  webhook_id?: Snowflake;
  /**
   * Type of message
   *
   * @see {@link https://discord.com/developers/docs/resources/message#message-object-message-types}
   */
  type: MessageType;
  /**
   * Sent with Rich Presence-related chat embeds
   *
   * @see {@link https://discord.com/developers/docs/resources/message#message-object-message-activity-structure}
   */
  activity?: APIMessageActivity;
  /**
   * Sent with Rich Presence-related chat embeds
   *
   * @see {@link https://discord.com/developers/docs/resources/application#application-object}
   */
  application?: Partial<APIApplication>;
  /**
   * If the message is a response to an Interaction, this is the id of the interaction's application
   */
  application_id?: Snowflake;
  /**
   * Reference data sent with crossposted messages, replies, pins, and thread starter messages
   *
   * @see {@link https://discord.com/developers/docs/resources/message#message-reference-structure}
   */
  message_reference?: APIMessageReference;
  /**
   * Message flags combined as a bitfield
   *
   * @see {@link https://discord.com/developers/docs/resources/message#message-object-message-flags}
   * @see {@link https://en.wikipedia.org/wiki/Bit_field}
   */
  flags?: MessageFlags;
  /**
   * The message associated with the `message_reference`
   *
   * This field is only returned for messages with a `type` of `19` (REPLY).
   *
   * If the message is a reply but the `referenced_message` field is not present,
   * the backend did not attempt to fetch the message that was being replied to,
   * so its state is unknown.
   *
   * If the field exists but is `null`, the referenced message was deleted
   *
   * @see {@link https://discord.com/developers/docs/resources/message#message-object}
   */
  referenced_message?: APIMessage | null;
  /**
   * Sent if the message is sent as a result of an interaction
   */
  interaction_metadata?: APIMessageInteractionMetadata;
  /**
   * Sent if the message is a response to an Interaction
   *
   * @deprecated In favor of `interaction_metadata`
   */
  interaction?: APIMessageInteraction;
  /**
   * Sent if a thread was started from this message
   */
  thread?: APIChannel;
  /**
   * Sent if the message contains components like buttons, action rows, or other interactive components
   *
   * The `MESSAGE_CONTENT` privileged gateway intent is required for verified applications to receive a non-empty value from this field
   *
   * In the Discord Developers Portal, you need to enable the toggle of this intent of your application in **Bot \> Privileged Gateway Intents**.
   * You also need to specify the intent bit value (`1 << 15`) if you are connecting to the gateway
   *
   * @see {@link https://support-dev.discord.com/hc/articles/6207308062871}
   */
  components?: APIMessageTopLevelComponent[];
  /**
   * Sent if the message contains stickers
   *
   * @see {@link https://discord.com/developers/docs/resources/sticker#sticker-item-object}
   */
  sticker_items?: APIStickerItem[];
  /**
   * The stickers sent with the message
   *
   * @see {@link https://discord.com/developers/docs/resources/sticker#sticker-object}
   * @deprecated Use {@link APIBaseMessageNoChannel.sticker_items} instead
   */
  stickers?: APISticker[];
  /**
   * A generally increasing integer (there may be gaps or duplicates) that represents the approximate position of the message in a thread
   *
   * It can be used to estimate the relative position of the message in a thread in company with `total_message_sent` on parent thread
   */
  position?: number;
  /**
   * Data of the role subscription purchase or renewal that prompted this `ROLE_SUBSCRIPTION_PURCHASE` message
   */
  role_subscription_data?: APIMessageRoleSubscriptionData;
  /**
   * Data for users, members, channels, and roles in the message's auto-populated select menus
   *
   * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-resolved-data-structure}
   */
  resolved?: APIInteractionDataResolved;
  /**
   * A poll!
   *
   * The `MESSAGE_CONTENT` privileged gateway intent is required for verified applications to receive a non-empty value from this field
   *
   * In the Discord Developers Portal, you need to enable the toggle of this intent of your application in **Bot \> Privileged Gateway Intents**.
   * You also need to specify the intent bit value (`1 << 15`) if you are connecting to the gateway
   *
   * @see {@link https://support-dev.discord.com/hc/articles/6207308062871}
   */
  poll?: APIPoll;
  /**
   * The message associated with the message_reference. This is a minimal subset of fields in a message (e.g. author is excluded.)
   */
  message_snapshots?: APIMessageSnapshot[];
  /**
   * The call associated with the message
   */
  call?: APIMessageCall;
  /**
   * The custom client-side theme shared via the message
   */
  shared_client_theme?: APIMessageSharedClientTheme;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-object-message-structure}
 */
interface APIBaseMessage extends APIBaseMessageNoChannel {
  /**
   * ID of the channel the message was sent in
   */
  channel_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-object-message-structure}
 */
interface APIMessage extends APIBaseMessage, APIMessageMentions {}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-object-message-types}
 */
declare enum MessageType {
  Default = 0,
  RecipientAdd = 1,
  RecipientRemove = 2,
  Call = 3,
  ChannelNameChange = 4,
  ChannelIconChange = 5,
  ChannelPinnedMessage = 6,
  UserJoin = 7,
  GuildBoost = 8,
  GuildBoostTier1 = 9,
  GuildBoostTier2 = 10,
  GuildBoostTier3 = 11,
  ChannelFollowAdd = 12,
  GuildDiscoveryDisqualified = 14,
  GuildDiscoveryRequalified = 15,
  GuildDiscoveryGracePeriodInitialWarning = 16,
  GuildDiscoveryGracePeriodFinalWarning = 17,
  ThreadCreated = 18,
  Reply = 19,
  ChatInputCommand = 20,
  ThreadStarterMessage = 21,
  GuildInviteReminder = 22,
  ContextMenuCommand = 23,
  AutoModerationAction = 24,
  RoleSubscriptionPurchase = 25,
  InteractionPremiumUpsell = 26,
  StageStart = 27,
  StageEnd = 28,
  StageSpeaker = 29,
  /**
   * @unstable https://github.com/discord/discord-api-docs/pull/5927#discussion_r1107678548
   */
  StageRaiseHand = 30,
  StageTopic = 31,
  GuildApplicationPremiumSubscription = 32,
  GuildIncidentAlertModeEnabled = 36,
  GuildIncidentAlertModeDisabled = 37,
  GuildIncidentReportRaid = 38,
  GuildIncidentReportFalseAlarm = 39,
  PurchaseNotification = 44,
  PollResult = 46
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-object-message-activity-structure}
 */
interface APIMessageActivity {
  /**
   * Type of message activity
   *
   * @see {@link https://discord.com/developers/docs/resources/message#message-object-message-activity-types}
   */
  type: MessageActivityType;
  /**
   * `party_id` from a Rich Presence event
   *
   * @see {@link https://discord.com/developers/docs/rich-presence/how-to#updating-presence-update-presence-payload-fields}
   */
  party_id?: string;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-reference-structure}
 */
interface APIMessageReference {
  /**
   * Type of reference
   */
  type?: MessageReferenceType;
  /**
   * ID of the originating message
   */
  message_id?: Snowflake;
  /**
   * ID of the originating message's channel
   */
  channel_id: Snowflake;
  /**
   * ID of the originating message's guild
   */
  guild_id?: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-object-message-activity-types}
 */
declare enum MessageActivityType {
  Join = 1,
  Spectate = 2,
  Listen = 3,
  JoinRequest = 5
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-reference-types}
 */
declare enum MessageReferenceType {
  /**
   * A standard reference used by replies
   */
  Default = 0,
  /**
   * Reference used to point to a message at a point in time
   */
  Forward = 1
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-object-message-flags}
 */
declare enum MessageFlags {
  /**
   * This message has been published to subscribed channels (via Channel Following)
   */
  Crossposted = 1,
  /**
   * This message originated from a message in another channel (via Channel Following)
   */
  IsCrosspost = 2,
  /**
   * Do not include any embeds when serializing this message
   */
  SuppressEmbeds = 4,
  /**
   * The source message for this crosspost has been deleted (via Channel Following)
   */
  SourceMessageDeleted = 8,
  /**
   * This message came from the urgent message system
   */
  Urgent = 16,
  /**
   * This message has an associated thread, which shares its id
   */
  HasThread = 32,
  /**
   * This message is only visible to the user who invoked the Interaction
   */
  Ephemeral = 64,
  /**
   * This message is an Interaction Response and the bot is "thinking"
   */
  Loading = 128,
  /**
   * This message failed to mention some roles and add their members to the thread
   */
  FailedToMentionSomeRolesInThread = 256,
  /**
   * @unstable This message flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  ShouldShowLinkNotDiscordWarning = 1024,
  /**
   * This message will not trigger push and desktop notifications
   */
  SuppressNotifications = 4096,
  /**
   * This message is a voice message
   */
  IsVoiceMessage = 8192,
  /**
   * This message has a snapshot (via Message Forwarding)
   */
  HasSnapshot = 16384,
  /**
   * Allows you to create fully component-driven messages
   *
   * @see {@link https://discord.com/developers/docs/components/overview}
   */
  IsComponentsV2 = 32768
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-call-object-message-call-object-structure}
 */
interface APIMessageCall {
  /**
   * Array of user ids that participated in the call
   */
  participants: Snowflake[];
  /**
   * ISO8601 timestamp when the call ended
   */
  ended_timestamp?: string | null;
}
/**
 * @see https://docs.discord.com/developers/resources/message#base-theme-types
 */
declare enum BaseThemeType {
  Unset = 0,
  Dark = 1,
  Light = 2,
  Darker = 3,
  Midnight = 4
}
/**
 * @see https://docs.discord.com/developers/resources/message#shared-client-theme-object
 */
interface APIMessageSharedClientTheme {
  /**
   * The hexadecimal-encoded colors of the theme (max of 5)
   */
  colors: string[];
  /**
   * The direction of the theme's colors (max of 360)
   */
  gradient_angle: number;
  /**
   * The intensity of the theme's colors (max of 100)
   */
  base_mix: number;
  /**
   * The mode of the theme
   */
  base_theme?: BaseThemeType | null;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#role-subscription-data-object-role-subscription-data-object-structure}
 */
interface APIMessageRoleSubscriptionData {
  /**
   * The id of the SKU and listing the user is subscribed to
   */
  role_subscription_listing_id: Snowflake;
  /**
   * The name of the tier the user is subscribed to
   */
  tier_name: string;
  /**
   * The number of months the user has been subscribed for
   */
  total_months_subscribed: number;
  /**
   * Whether this notification is for a renewal
   */
  is_renewal: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#reaction-object-reaction-structure}
 */
interface APIReaction {
  /**
   * Total number of times this emoji has been used to react (including super reacts)
   */
  count: number;
  /**
   * An object detailing the individual reaction counts for different types of reactions
   */
  count_details: APIReactionCountDetails;
  /**
   * Whether the current user reacted using this emoji
   */
  me: boolean;
  /**
   * Whether the current user super-reacted using this emoji
   */
  me_burst: boolean;
  /**
   * Emoji information
   *
   * @see {@link https://discord.com/developers/docs/resources/emoji#emoji-object}
   */
  emoji: APIPartialEmoji;
  /**
   * Hexadecimal colors used for this super reaction
   */
  burst_colors: string[];
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#reaction-count-details-object-reaction-count-details-structure}
 */
interface APIReactionCountDetails {
  /**
   * Count of super reactions
   */
  burst: number;
  /**
   * Count of normal reactions
   */
  normal: number;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-structure}
 *
 * Length limit: 6000 characters
 */
interface APIEmbed {
  /**
   * Title of embed
   *
   * Length limit: 256 characters
   */
  title?: string;
  /**
   * Type of embed (always "rich" for webhook embeds)
   */
  type?: EmbedType;
  /**
   * Description of embed
   *
   * Length limit: 4096 characters
   */
  description?: string;
  /**
   * URL of embed
   */
  url?: string;
  /**
   * Timestamp of embed content
   */
  timestamp?: string;
  /**
   * Color code of the embed
   */
  color?: number;
  /**
   * Footer information
   *
   * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-footer-structure}
   */
  footer?: APIEmbedFooter;
  /**
   * Image information
   *
   * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-image-structure}
   */
  image?: APIEmbedImage;
  /**
   * Thumbnail information
   *
   * @see {@link https://docs.discord.com/developers/resources/message#embed-object-embed-image-structure}
   */
  thumbnail?: APIEmbedImage;
  /**
   * Video information
   *
   * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-video-structure}
   */
  video?: APIEmbedVideo;
  /**
   * Provider information
   *
   * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-provider-structure}
   */
  provider?: APIEmbedProvider;
  /**
   * Author information
   *
   * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-author-structure}
   */
  author?: APIEmbedAuthor;
  /**
   * Fields information
   *
   * Length limit: 25 field objects
   *
   * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-field-structure}
   */
  fields?: APIEmbedField[];
  /**
   * Embed flags combined as a bitfield
   *
   * @see {@link https://docs.discord.com/developers/resources/message#embed-object-embed-flags}
   * @see {@link https://en.wikipedia.org/wiki/Bit_field}
   */
  flags?: EmbedFlags;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-types}
 */
declare enum EmbedType {
  /**
   * Generic embed rendered from embed attributes
   */
  Rich = "rich",
  /**
   * Image embed
   */
  Image = "image",
  /**
   * Video embed
   */
  Video = "video",
  /**
   * Animated gif image embed rendered as a video embed
   */
  GIFV = "gifv",
  /**
   * Article embed
   */
  Article = "article",
  /**
   * Link embed
   */
  Link = "link",
  /**
   * Auto moderation alert embed
   *
   * @unstable This embed type is currently not documented by Discord, but it is returned in the auto moderation system messages.
   */
  AutoModerationMessage = "auto_moderation_message",
  /**
   * Poll result embed
   */
  PollResult = "poll_result"
}
/**
 * @see {@link https://docs.discord.com/developers/resources/message#embed-object-embed-flags}
 */
declare enum EmbedFlags {
  /**
   * This embed is a fallback for a reply to an activity card
   */
  IsContentInventoryEntry = 32
}
/**
 * @see {@link https://docs.discord.com/developers/resources/message#embed-object-embed-media-flags}
 */
declare enum EmbedMediaFlags {
  /**
   * This image is animated
   */
  IsAnimated = 32
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-video-structure}
 */
interface APIEmbedVideo {
  /**
   * Source url of video
   */
  url?: string;
  /**
   * A proxied url of the video
   */
  proxy_url?: string;
  /**
   * Height of video
   */
  height?: number;
  /**
   * Width of video
   */
  width?: number;
  /**
   * The video's media type
   *
   * @see {@link https://en.wikipedia.org/wiki/Media_type}
   */
  content_type?: string;
  /**
   * ThumbHash placeholder of the video
   *
   * @see {@link https://evanw.github.io/thumbhash/}
   */
  placeholder?: string;
  /**
   * Version of the placeholder
   */
  placeholder_version?: number;
  /**
   * Description (alt text) for the video
   */
  description?: string;
  /**
   * Embed media flags combined as a bitfield
   *
   * @see {@link https://docs.discord.com/developers/resources/message#embed-object-embed-media-flags}
   * @see {@link https://en.wikipedia.org/wiki/Bit_field}
   */
  flags?: EmbedMediaFlags;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-image-structure}
 */
interface APIEmbedImage {
  /**
   * Source url of image (only supports http(s) and attachments)
   */
  url: string;
  /**
   * A proxied url of the image
   */
  proxy_url?: string;
  /**
   * Height of image
   */
  height?: number;
  /**
   * Width of image
   */
  width?: number;
  /**
   * The image's media type
   *
   * @see {@link https://en.wikipedia.org/wiki/Media_type}
   */
  content_type?: string;
  /**
   * ThumbHash placeholder of the image
   *
   * @see {@link https://evanw.github.io/thumbhash/}
   */
  placeholder?: string;
  /**
   * Version of the placeholder
   */
  placeholder_version?: number;
  /**
   * Description (alt text) for the image
   */
  description?: string;
  /**
   * Embed media flags combined as a bitfield
   *
   * @see {@link https://docs.discord.com/developers/resources/message#embed-object-embed-media-flags}
   * @see {@link https://en.wikipedia.org/wiki/Bit_field}
   */
  flags?: EmbedMediaFlags;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-provider-structure}
 */
interface APIEmbedProvider {
  /**
   * Name of provider
   */
  name?: string;
  /**
   * URL of provider
   */
  url?: string;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-author-structure}
 */
interface APIEmbedAuthor {
  /**
   * Name of author
   *
   * Length limit: 256 characters
   */
  name: string;
  /**
   * URL of author
   */
  url?: string;
  /**
   * URL of author icon (only supports http(s) and attachments)
   */
  icon_url?: string;
  /**
   * A proxied url of author icon
   */
  proxy_icon_url?: string;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-footer-structure}
 */
interface APIEmbedFooter {
  /**
   * Footer text
   *
   * Length limit: 2048 characters
   */
  text: string;
  /**
   * URL of footer icon (only supports http(s) and attachments)
   */
  icon_url?: string;
  /**
   * A proxied url of footer icon
   */
  proxy_icon_url?: string;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-field-structure}
 */
interface APIEmbedField {
  /**
   * Name of the field
   *
   * Length limit: 256 characters
   */
  name: string;
  /**
   * Value of the field
   *
   * Length limit: 1024 characters
   */
  value: string;
  /**
   * Whether or not this field should display inline
   */
  inline?: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#attachment-object-attachment-structure}
 */
interface APIAttachment {
  /**
   * Attachment id
   */
  id: Snowflake;
  /**
   * Name of file attached
   */
  filename: string;
  /**
   * The original filename of the upload with special characters preserved
   *
   * This will be present when the filename contains special characters (e.g. Cyrillic),
   * in which case the `filename` field will be a sanitized version without those characters
   */
  title?: string;
  /**
   * Description (alt text) for the file (max 1024 characters)
   */
  description?: string;
  /**
   * The attachment's media type
   *
   * @see {@link https://en.wikipedia.org/wiki/Media_type}
   */
  content_type?: string;
  /**
   * Size of file in bytes
   */
  size: number;
  /**
   * Source url of file
   */
  url: string;
  /**
   * A proxied url of file
   */
  proxy_url: string;
  /**
   * Height of file (if image or video)
   */
  height?: number | null;
  /**
   * Width of file (if image or video)
   */
  width?: number | null;
  /**
   * ThumbHash placeholder (if image or video)
   *
   * @see {@link https://evanw.github.io/thumbhash/}
   */
  placeholder?: string;
  /**
   * Version of the placeholder (if image or video)
   */
  placeholder_version?: number;
  /**
   * Whether this attachment is ephemeral
   *
   * @remarks Ephemeral attachments will automatically be removed after a set period of time. Ephemeral attachments on messages are guaranteed to be available as long as the message itself exists.
   */
  ephemeral?: boolean;
  /**
   * The duration of the audio file (currently for voice messages)
   */
  duration_secs?: number;
  /**
   * Base64 encoded bytearray representing a sampled waveform (currently for voice messages)
   */
  waveform?: string;
  /**
   * Attachment flags combined as a bitfield
   */
  flags?: AttachmentFlags;
  /**
   * For Clips, array of users who were in the stream
   */
  clip_participants?: APIUser[];
  /**
   * For Clips, when the clip was created
   */
  clip_created_at?: string;
  /**
   * For Clips, the application in the stream, if recognized
   */
  application?: APIApplication | null;
}
/**
 * @see {@link https://docs.discord.com/developers/resources/message#attachment-object-attachment-flags}
 */
declare enum AttachmentFlags {
  /**
   * This attachment is a Clip from a stream
   *
   * @see {@link https://support.discord.com/hc/en-us/articles/16861982215703}
   */
  IsClip = 1,
  /**
   * This attachment is the thumbnail of a thread in a media channel, displayed in the grid but not on the message
   */
  IsThumbnail = 2,
  /**
   * This attachment has been edited using the remix feature on mobile
   *
   * @deprecated
   */
  IsRemix = 4,
  /**
   * This attachment was marked as a spoiler and is blurred until clicked
   */
  IsSpoiler = 8,
  /**
   * This attachment is an animated image
   */
  IsAnimated = 32
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#channel-mention-object-channel-mention-structure}
 */
interface APIChannelMention {
  /**
   * ID of the channel
   */
  id: Snowflake;
  /**
   * ID of the guild containing the channel
   */
  guild_id: Snowflake;
  /**
   * The type of channel
   *
   * @see {@link https://discord.com/developers/docs/resources/message#channel-object-channel-types}
   */
  type: ChannelType;
  /**
   * The name of the channel
   */
  name: string;
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference#anatomy-of-a-component}
 */
interface APIBaseComponent<T extends ComponentType> {
  /**
   * The type of the component
   */
  type: T;
  /**
   * 32 bit integer used as an optional identifier for component
   *
   * The id field is optional and is used to identify components in the response from an interaction that aren't interactive components. The id must be unique within the message and is generated sequentially if left empty. Generation of ids won't use another id that exists in the message if you have one defined for another component.
   */
  id?: number;
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference#component-object-component-types}
 */
declare enum ComponentType {
  /**
   * Container to display a row of interactive components
   */
  ActionRow = 1,
  /**
   * Button component
   */
  Button = 2,
  /**
   * Select menu for picking from defined text options
   */
  StringSelect = 3,
  /**
   * Text Input component
   */
  TextInput = 4,
  /**
   * Select menu for users
   */
  UserSelect = 5,
  /**
   * Select menu for roles
   */
  RoleSelect = 6,
  /**
   * Select menu for users and roles
   */
  MentionableSelect = 7,
  /**
   * Select menu for channels
   */
  ChannelSelect = 8,
  /**
   * Container to display text alongside an accessory component
   */
  Section = 9,
  /**
   * Markdown text
   */
  TextDisplay = 10,
  /**
   * Small image that can be used as an accessory
   */
  Thumbnail = 11,
  /**
   * Display images and other media
   */
  MediaGallery = 12,
  /**
   * Displays an attached file
   */
  File = 13,
  /**
   * Component to add vertical padding between other components
   */
  Separator = 14,
  /**
   * @unstable This component type is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  ContentInventoryEntry = 16,
  /**
   * Container that visually groups a set of components
   */
  Container = 17,
  /**
   * Container associating a label and description with a component
   */
  Label = 18,
  /**
   * Component for uploading files
   */
  FileUpload = 19,
  /**
   * Single-choice set of radio group option
   */
  RadioGroup = 21,
  /**
   * Multi-select group of checkboxes
   */
  CheckboxGroup = 22,
  /**
   * Single checkbox for binary choice
   */
  Checkbox = 23,
  /**
   * Select menu for picking from defined text options
   *
   * @deprecated This is the old name for {@link ComponentType.StringSelect}
   */
  SelectMenu = 3
}
/**
 * An Action Row is a top-level layout component used in messages. Use in modals is deprecated.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#action-row}
 */
interface APIActionRowComponent<T extends APIComponentInActionRow> extends APIBaseComponent<ComponentType.ActionRow> {
  /**
   * The components in the ActionRow
   */
  components: T[];
}
interface APIButtonBase<Style extends ButtonStyle> extends APIBaseComponent<ComponentType.Button> {
  /**
   * The style of the button
   */
  style: Style;
  /**
   * The status of the button
   */
  disabled?: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference#button}
 */
interface APIButtonComponentBase<Style extends ButtonStyle> extends APIButtonBase<Style> {
  /**
   * The label to be displayed on the button
   */
  label?: string;
  /**
   * The emoji to display to the left of the text
   */
  emoji?: APIMessageComponentEmoji;
}
interface APIMessageComponentEmoji {
  /**
   * Emoji id
   */
  id?: Snowflake;
  /**
   * Emoji name
   */
  name?: string;
  /**
   * Whether this emoji is animated
   */
  animated?: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference#button}
 */
interface APIButtonComponentWithCustomId extends APIButtonComponentBase<ButtonStyle.Danger | ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success> {
  /**
   * The custom_id to be sent in the interaction when clicked
   */
  custom_id: string;
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference#button}
 */
interface APIButtonComponentWithURL extends APIButtonComponentBase<ButtonStyle.Link> {
  /**
   * The URL to direct users to when clicked for Link buttons
   */
  url: string;
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference#button}
 */
interface APIButtonComponentWithSKUId extends APIButtonBase<ButtonStyle.Premium> {
  /**
   * The id for a purchasable SKU
   */
  sku_id: Snowflake;
}
/**
 * A Button is an interactive component that can only be used in messages. It creates clickable elements that users can interact with, sending an interaction to your app when clicked.
 *
 * Buttons must be placed inside an Action Row or a Section's accessory field.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#button}
 */
type APIButtonComponent = APIButtonComponentWithCustomId | APIButtonComponentWithSKUId | APIButtonComponentWithURL;
/**
 * @see {@link https://discord.com/developers/docs/components/reference#button-button-styles}
 */
declare enum ButtonStyle {
  /**
   * The most important or recommended action in a group of options
   */
  Primary = 1,
  /**
   * Alternative or supporting actions
   */
  Secondary = 2,
  /**
   * Positive confirmation or completion actions
   */
  Success = 3,
  /**
   * An action with irreversible consequences
   */
  Danger = 4,
  /**
   * Navigates to a URL
   */
  Link = 5,
  /**
   * Purchase
   */
  Premium = 6
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference#text-input-text-input-styles}
 */
declare enum TextInputStyle {
  /**
   * Single-line input
   */
  Short = 1,
  /**
   * Multi-line input
   */
  Paragraph = 2
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference}
 */
interface APIBaseSelectMenuComponent<T extends ComponentType.ChannelSelect | ComponentType.MentionableSelect | ComponentType.RoleSelect | ComponentType.StringSelect | ComponentType.UserSelect> extends APIBaseComponent<T> {
  /**
   * A developer-defined identifier for the select menu, max 100 characters
   */
  custom_id: string;
  /**
   * Custom placeholder text if nothing is selected, max 150 characters
   */
  placeholder?: string;
  /**
   * The minimum number of items that must be chosen; min 0, max 25
   *
   * @defaultValue `1`
   */
  min_values?: number;
  /**
   * The maximum number of items that can be chosen; max 25
   *
   * @defaultValue `1`
   */
  max_values?: number;
  /**
   * Disable the select
   *
   * @defaultValue `false`
   */
  disabled?: boolean;
  /**
   * Whether the component is required to answer in a modal.
   *
   * @defaultValue `true`
   */
  required?: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference}
 */
interface APIBaseAutoPopulatedSelectMenuComponent<T extends ComponentType.ChannelSelect | ComponentType.MentionableSelect | ComponentType.RoleSelect | ComponentType.UserSelect, D extends SelectMenuDefaultValueType> extends APIBaseSelectMenuComponent<T> {
  /**
   * List of default values for auto-populated select menu components
   */
  default_values?: APISelectMenuDefaultValue<D>[];
}
/**
 * A String Select is an interactive component that allows users to select one or more provided options in a message.
 *
 * String Selects can be configured for both single-select and multi-select behavior. When a user finishes making their choice(s) your app receives an interaction.
 *
 * An Action Row can contain only one select menu and cannot contain buttons if it has a select menu.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#string-select}
 */
interface APIStringSelectComponent extends APIBaseSelectMenuComponent<ComponentType.StringSelect> {
  /**
   * Specified choices in a select menu; max 25
   */
  options: APISelectMenuOption[];
}
/**
 * A User Select is an interactive component that allows users to select one or more users in a message. Options are automatically populated based on the server's available users.
 *
 * User Selects can be configured for both single-select and multi-select behavior. When a user finishes making their choice(s) your app receives an interaction.
 *
 * User Selects must be placed inside an Action Row and are only available in messages. An Action Row can contain only one select menu and cannot contain buttons if it has a select menu.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#user-select}
 */
type APIUserSelectComponent = APIBaseAutoPopulatedSelectMenuComponent<ComponentType.UserSelect, SelectMenuDefaultValueType.User>;
/**
 * A Role Select is an interactive component that allows users to select one or more roles in a message. Options are automatically populated based on the server's available roles.
 *
 * Role Selects can be configured for both single-select and multi-select behavior. When a user finishes making their choice(s) your app receives an interaction.
 *
 * Role Selects must be placed inside an Action Row and are only available in messages. An Action Row can contain only one select menu and cannot contain buttons if it has a select menu.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#role-select}
 */
type APIRoleSelectComponent = APIBaseAutoPopulatedSelectMenuComponent<ComponentType.RoleSelect, SelectMenuDefaultValueType.Role>;
/**
 * A Mentionable Select is an interactive component that allows users to select one or more mentionables in a message. Options are automatically populated based on available mentionables in the server.
 *
 * Mentionable Selects can be configured for both single-select and multi-select behavior. When a user finishes making their choice(s), your app receives an interaction.
 *
 * Mentionable Selects must be placed inside an Action Row and are only available in messages. An Action Row can contain only one select menu and cannot contain buttons if it has a select menu.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#mentionable-select}
 */
type APIMentionableSelectComponent = APIBaseAutoPopulatedSelectMenuComponent<ComponentType.MentionableSelect, SelectMenuDefaultValueType.Role | SelectMenuDefaultValueType.User>;
/**
 * A Channel Select is an interactive component that allows users to select one or more channels in a message. Options are automatically populated based on available channels in the server and can be filtered by channel types.
 *
 * Channel Selects can be configured for both single-select and multi-select behavior. When a user finishes making their choice(s) your app receives an interaction.
 *
 * Channel Selects must be placed inside an Action Row and are only available in messages. An Action Row can contain only one select menu and cannot contain buttons if it has a select menu.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#channel-select}
 */
interface APIChannelSelectComponent extends APIBaseAutoPopulatedSelectMenuComponent<ComponentType.ChannelSelect, SelectMenuDefaultValueType.Channel> {
  /**
   * List of channel types to include in the ChannelSelect component
   */
  channel_types?: ChannelType[];
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference#user-select-select-default-value-structure}
 */
declare enum SelectMenuDefaultValueType {
  Channel = "channel",
  Role = "role",
  User = "user"
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference#user-select-select-default-value-structure}
 */
interface APISelectMenuDefaultValue<T extends SelectMenuDefaultValueType> {
  type: T;
  id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference}
 */
type APISelectMenuComponent = APIChannelSelectComponent | APIMentionableSelectComponent | APIRoleSelectComponent | APIStringSelectComponent | APIUserSelectComponent;
/**
 * @see {@link https://discord.com/developers/docs/components/reference#string-select-select-option-structure}
 */
interface APISelectMenuOption {
  /**
   * The user-facing name of the option (max 100 chars)
   */
  label: string;
  /**
   * The dev-defined value of the option (max 100 chars)
   */
  value: string;
  /**
   * An additional description of the option (max 100 chars)
   */
  description?: string;
  /**
   * The emoji to display to the left of the option
   */
  emoji?: APIMessageComponentEmoji;
  /**
   * Whether this option should be already-selected by default
   */
  default?: boolean;
}
/**
 * Text input is an interactive component that allows users to enter free-form text responses in modals. It supports both short, single-line inputs and longer, multi-line paragraph inputs.
 *
 * Text inputs can only be used within modals.
 *
 * When defining a text input component, you can set attributes to customize the behavior and appearance of it. However, not all attributes will be returned in the text input interaction payload.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#text-input}
 */
interface APITextInputComponent extends APIBaseComponent<ComponentType.TextInput> {
  /**
   * One of text input styles
   */
  style: TextInputStyle;
  /**
   * The custom id for the text input
   */
  custom_id: string;
  /**
   * Text that appears on top of the text input field, max 45 characters.
   *
   * @remarks Cannot be used in a label component.
   */
  label?: string;
  /**
   * Placeholder for the text input
   */
  placeholder?: string;
  /**
   * The pre-filled text in the text input
   */
  value?: string;
  /**
   * Minimal length of text input
   */
  min_length?: number;
  /**
   * Maximal length of text input
   */
  max_length?: number;
  /**
   * Whether this text input is required
   */
  required?: boolean;
}
/**
 * @unstable This enum is currently not documented by Discord
 */
declare enum UnfurledMediaItemLoadingState {
  Unknown = 0,
  Loading = 1,
  LoadedSuccess = 2,
  LoadedNotFound = 3
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference#unfurled-media-item-structure}
 */
interface APIUnfurledMediaItem {
  /**
   * Supports arbitrary urls and `attachment://<filename>` references
   */
  url: string;
  /**
   * The proxied url of the media item
   *
   * @remarks This field is ignored and provided by the API as part of the response.
   */
  proxy_url?: string;
  /**
   * The width of the media item (if image or video)
   *
   * @remarks This field is ignored and provided by the API as part of the response.
   */
  width?: number | null;
  /**
   * The height of the media item (if image or video)
   *
   * @remarks This field is ignored and provided by the API as part of the response.
   */
  height?: number | null;
  /**
   * ThumbHash placeholder (if image or video)
   *
   * @remarks This field is ignored and provided by the API as part of the response.
   * @see {@link https://evanw.github.io/thumbhash/}
   */
  placeholder?: string | null;
  /**
   * Version of the placeholder (if image or video)
   *
   * @remarks This field is ignored and provided by the API as part of the response.
   */
  placeholder_version?: number | null;
  /**
   * The media type of the content
   *
   * @remarks This field is ignored and provided by the API as part of the response.
   * @see {@link https://en.wikipedia.org/wiki/Media_type}
   */
  content_type?: string | null;
  /**
   * @unstable This field is currently not documented by Discord
   */
  loading_state?: UnfurledMediaItemLoadingState;
  /**
   * Unfurled media item flags combined as a bitfield
   *
   * @remarks This field is ignored and provided by the API as part of the response.
   * @see {@link https://docs.discord.com/developers/components/reference#unfurled-media-item-unfurled-media-item-flags}
   * @see {@link https://en.wikipedia.org/wiki/Bit_field}
   */
  flags?: UnfurledMediaItemFlags;
  /**
   * The id of the uploaded attachment.
   *
   * @remarks This field is ignored and provided by the API as part of the response.
   * @remarks Only present if the media item was uploaded as an attachment.
   */
  attachment_id?: Snowflake;
}
/**
 * @see {@link https://docs.discord.com/developers/components/reference#unfurled-media-item-unfurled-media-item-flags}
 */
declare enum UnfurledMediaItemFlags {
  /**
   * This image is animated
   */
  IsAnimated = 1
}
/**
 * A Section is a top-level layout component that allows you to join text contextually with an accessory.
 *
 * Sections are only available in messages.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#section}
 */
interface APISectionComponent extends APIBaseComponent<ComponentType.Section> {
  /**
   * One to three text components
   */
  components: APITextDisplayComponent[];
  /**
   * A thumbnail or a button component, with a future possibility of adding more compatible components
   */
  accessory: APISectionAccessoryComponent;
}
/**
 * A Text Display is a top-level content component that allows you to add text to your message formatted with markdown and mention users and roles. This is similar to the content field of a message, but allows you to add multiple text components, controlling the layout of your message.
 *
 * Text Displays are only available in messages.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#text-display}
 */
interface APITextDisplayComponent extends APIBaseComponent<ComponentType.TextDisplay> {
  /**
   * Text that will be displayed similar to a message
   */
  content: string;
}
/**
 * A Thumbnail is a content component that is a small image only usable as an accessory in a section. The preview comes from an url or attachment through the unfurled media item structure.
 *
 * Thumbnails are only available in messages as an accessory in a section.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#thumbnail}
 */
interface APIThumbnailComponent extends APIBaseComponent<ComponentType.Thumbnail> {
  /**
   * A url or attachment
   */
  media: APIUnfurledMediaItem;
  /**
   * Alt text for the media
   */
  description?: string | null;
  /**
   * Whether the thumbnail should be a spoiler (or blurred out)
   *
   * @defaultValue `false`
   */
  spoiler?: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference#media-gallery-media-gallery-item-structure}
 */
interface APIMediaGalleryItem {
  /**
   * A url or attachment
   */
  media: APIUnfurledMediaItem;
  /**
   * Alt text for the media
   */
  description?: string | null;
  /**
   * Whether the media should be a spoiler (or blurred out)
   *
   * @defaultValue `false`
   */
  spoiler?: boolean;
}
/**
 * A Media Gallery is a top-level content component that allows you to display 1-10 media attachments in an organized gallery format. Each item can have optional descriptions and can be marked as spoilers.
 *
 * Media Galleries are only available in messages.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#media-gallery}
 */
interface APIMediaGalleryComponent extends APIBaseComponent<ComponentType.MediaGallery> {
  /**
   * 1 to 10 media gallery items
   */
  items: APIMediaGalleryItem[];
}
/**
 * A File is a top-level component that allows you to display an uploaded file as an attachment to the message and reference it in the component.
 *
 * Each file component can only display 1 attached file, but you can upload multiple files and add them to different file components within your payload.
 *
 * Files are only available in messages.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#file}
 */
interface APIFileComponent extends APIBaseComponent<ComponentType.File> {
  /**
   * This unfurled media item is unique in that it **only** support attachment references using the `attachment://<filename>` syntax
   */
  file: APIUnfurledMediaItem;
  /**
   * Whether the media should be a spoiler (or blurred out)
   *
   * @defaultValue `false`
   */
  spoiler?: boolean;
  /**
   * The name of the file. This field is ignored and provided by the API as part of the response
   */
  name?: string;
  /**
   * The size of the file in bytes. This field is ignored and provided by the API as part of the response
   */
  size?: number;
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference#separator}
 */
declare enum SeparatorSpacingSize {
  Small = 1,
  Large = 2
}
/**
 * A Separator is a top-level layout component that adds vertical padding and visual division between other components.
 *
 * Separators are only available in messages.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#separator}
 */
interface APISeparatorComponent extends APIBaseComponent<ComponentType.Separator> {
  /**
   * Whether a visual divider should be displayed in the component
   *
   * @defaultValue `true`
   */
  divider?: boolean;
  /**
   * Size of separator padding
   *
   * @defaultValue `SeparatorSpacingSize.Small`
   */
  spacing?: SeparatorSpacingSize;
}
/**
 * A Container is a top-level layout component that holds up to 10 components. Containers are visually distinct from surrounding components and has an optional customizable color bar.
 *
 * Containers are only available in messages.
 *
 * @see {@link https://discord.com/developers/docs/components/reference#container}
 */
interface APIContainerComponent extends APIBaseComponent<ComponentType.Container> {
  /**
   * Color for the accent on the container as RGB from `0x000000` to `0xFFFFFF`
   */
  accent_color?: number | null;
  /**
   * Whether the container should be a spoiler (or blurred out)
   *
   * @defaultValue `false`
   */
  spoiler?: boolean;
  /**
   * Up to 10 components of the type action row, text display, section, media gallery, separator, or file
   */
  components: APIComponentInContainer[];
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-snapshot-object}
 */
interface APIMessageSnapshot {
  /**
   * Subset of the message object fields
   */
  message: APIMessageSnapshotFields;
  /**
   * Id of the origin message's guild
   *
   * @deprecated This field doesn't accurately reflect the Discord API as it doesn't exist nor is documented and will
   * be removed in the next major version.
   *
   * It was added in {@link https://github.com/discord/discord-api-docs/pull/6833/commits/d18f72d06d62e6b1d51ca2c1ef308ddc29ff3348 | d18f72d}
   * but was later removed before the PR ({@link https://github.com/discord/discord-api-docs/pull/6833 | discord-api-docs#6833}) was merged.
   * @see {@link https://github.com/discordjs/discord-api-types/pull/1084 | discord-api-types#1084} for more information.
   */
  guild_id?: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/components/reference}
 */
type APIMessageTopLevelComponent = APIActionRowComponent<APIComponentInMessageActionRow> | APIContainerComponent | APIFileComponent | APIMediaGalleryComponent | APISectionComponent | APISeparatorComponent | APITextDisplayComponent;
/**
 * @see {@link https://discord.com/developers/docs/components/reference#action-row}
 */
type APIComponentInActionRow = APIComponentInMessageActionRow | APIComponentInModalActionRow;
/**
 * @see {@link https://discord.com/developers/docs/components/reference#action-row}
 */
type APIComponentInMessageActionRow = APIButtonComponent | APISelectMenuComponent;
/**
 * @see {@link https://discord.com/developers/docs/components/reference#action-row}
 * @deprecated
 */
type APIComponentInModalActionRow = APITextInputComponent;
/**
 * @see {@link https://discord.com/developers/docs/components/reference#section}
 */
type APISectionAccessoryComponent = APIButtonComponent | APIThumbnailComponent;
/**
 * @see {@link https://discord.com/developers/docs/components/reference#container}
 */
type APIComponentInContainer = APIActionRowComponent<APIComponentInMessageActionRow> | APIFileComponent | APIMediaGalleryComponent | APISectionComponent | APISeparatorComponent | APITextDisplayComponent;
/**
 * https://discord.com/developers/docs/resources/message#message-snapshot-object
 */
type APIMessageSnapshotFields = Pick<APIMessage, 'attachments' | 'components' | 'content' | 'edited_timestamp' | 'embeds' | 'flags' | 'mention_roles' | 'mentions' | 'sticker_items' | 'stickers' | 'timestamp' | 'type'>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/monetization.d.ts
/**
 * @see {@link https://discord.com/developers/docs/monetization/entitlements#entitlement-object-entitlement-structure}
 */
interface APIEntitlement {
  /**
   * ID of the entitlement
   */
  id: Snowflake;
  /**
   * ID of the SKU
   */
  sku_id: Snowflake;
  /**
   * ID of the user that is granted access to the entitlement's sku
   */
  user_id?: Snowflake;
  /**
   * ID of the guild that is granted access to the entitlement's sku
   */
  guild_id?: Snowflake;
  /**
   * ID of the parent application
   */
  application_id: Snowflake;
  /**
   * Type of entitlement
   */
  type: EntitlementType;
  /**
   * Whether the entitlement was deleted
   */
  deleted: boolean;
  /**
   * Start date at which the entitlement is valid.
   */
  starts_at: string | null;
  /**
   * Date at which the entitlement is no longer valid.
   */
  ends_at: string | null;
  /**
   * For consumable items, whether or not the entitlement has been consumed
   */
  consumed?: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/monetization/entitlements#entitlement-object-entitlement-types}
 */
declare enum EntitlementType {
  /**
   * Entitlement was purchased by user
   */
  Purchase = 1,
  /**
   * Entitlement for Discord Nitro subscription
   */
  PremiumSubscription = 2,
  /**
   * Entitlement was gifted by developer
   */
  DeveloperGift = 3,
  /**
   * Entitlement was purchased by a dev in application test mode
   */
  TestModePurchase = 4,
  /**
   * Entitlement was granted when the SKU was free
   */
  FreePurchase = 5,
  /**
   * Entitlement was gifted by another user
   */
  UserGift = 6,
  /**
   * Entitlement was claimed by user for free as a Nitro Subscriber
   */
  PremiumPurchase = 7,
  /**
   * Entitlement was purchased as an app subscription
   */
  ApplicationSubscription = 8
}
/**
 * @see {@link https://discord.com/developers/docs/resources/subscription#subscription-object}
 */
interface APISubscription {
  /**
   * ID of the subscription
   */
  id: Snowflake;
  /**
   * ID of the user who is subscribed
   */
  user_id: Snowflake;
  /**
   * List of SKUs subscribed to
   */
  sku_ids: Snowflake[];
  /**
   * List of entitlements granted for this subscription
   */
  entitlement_ids: Snowflake[];
  /**
   * List of SKUs that this user will be subscribed to at renewal
   */
  renewal_sku_ids: Snowflake[] | null;
  /**
   * Start of the current subscription period
   */
  current_period_start: string;
  /**
   * End of the current subscription period
   */
  current_period_end: string;
  /**
   * Current status of the subscription
   */
  status: SubscriptionStatus;
  /**
   * When the subscription was canceled
   */
  canceled_at: string | null;
  /**
   * ISO3166-1 alpha-2 country code of the payment source used to purchase the subscription. Missing unless queried with a private OAuth scope.
   */
  country?: string;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/subscription#subscription-statuses}
 */
declare enum SubscriptionStatus {
  /**
   * Subscription is active and scheduled to renew.
   */
  Active = 0,
  /**
   * Subscription is active but will not renew.
   */
  Ending = 1,
  /**
   * Subscription is inactive and not being charged.
   */
  Inactive = 2
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/responses.d.ts
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-type}
 */
declare enum InteractionType {
  Ping = 1,
  ApplicationCommand = 2,
  MessageComponent = 3,
  ApplicationCommandAutocomplete = 4,
  ModalSubmit = 5
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type}
 */
declare enum InteractionResponseType {
  /**
   * ACK a `Ping`
   */
  Pong = 1,
  /**
   * Respond to an interaction with a message
   */
  ChannelMessageWithSource = 4,
  /**
   * ACK an interaction and edit to a response later, the user sees a loading state
   */
  DeferredChannelMessageWithSource = 5,
  /**
   * ACK a button interaction and update it to a loading state
   */
  DeferredMessageUpdate = 6,
  /**
   * ACK a button interaction and edit the message to which the button was attached
   */
  UpdateMessage = 7,
  /**
   * For autocomplete interactions
   */
  ApplicationCommandAutocompleteResult = 8,
  /**
   * Respond to an interaction with an modal for a user to fill-out
   */
  Modal = 9,
  /**
   * Respond to an interaction with an upgrade button, only available for apps with monetization enabled
   *
   * @deprecated Send a button with Premium type instead.
   * {@link https://discord.com/developers/docs/change-log#premium-apps-new-premium-button-style-deep-linking-url-schemes | Learn more here}
   */
  PremiumRequired = 10,
  /**
   * Launch the Activity associated with the app.
   *
   * @remarks
   * Only available for apps with Activities enabled
   */
  LaunchActivity = 12
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/base.d.ts
/**
 * @see {@link https://discord.com/developers/docs/resources/channel#message-interaction-metadata-object}
 */
type APIMessageInteractionMetadata = APIApplicationCommandInteractionMetadata | APIMessageComponentInteractionMetadata | APIModalSubmitInteractionMetadata;
interface APIBaseInteractionMetadata<Type extends InteractionType> {
  /**
   * ID of the interaction
   */
  id: Snowflake;
  /**
   * Type of interaction
   */
  type: Type;
  /**
   * User who triggered the interaction
   */
  user: APIUser;
  /**
   * IDs for installation context(s) related to an interaction
   */
  authorizing_integration_owners: APIAuthorizingIntegrationOwnersMap;
  /**
   * ID of the original response message, present only on follow-up messages
   */
  original_response_message_id?: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-interaction-metadata-object-application-command-interaction-metadata-structure}
 */
interface APIApplicationCommandInteractionMetadata extends APIBaseInteractionMetadata<InteractionType.ApplicationCommand> {
  /**
   * The user the command was run on, present only on user commands interactions
   */
  target_user?: APIUser;
  /**
   * The ID of the message the command was run on, present only on message command interactions.
   * The original response message will also have `message_reference` and `referenced_message` pointing to this message.
   */
  target_message_id?: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-interaction-metadata-object-message-command-interaction-metadata-structure}
 */
interface APIMessageComponentInteractionMetadata extends APIBaseInteractionMetadata<InteractionType.MessageComponent> {
  /**
   * ID of the message that contained the interactive component
   */
  interacted_message_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/message#message-interaction-metadata-object-modal-submit-interaction-metadata-structure}
 */
interface APIModalSubmitInteractionMetadata extends APIBaseInteractionMetadata<InteractionType.ModalSubmit> {
  /**
   * Metadata for the interaction that was used to open the modal
   */
  triggering_interaction_metadata: APIApplicationCommandInteractionMetadata | APIMessageComponentInteractionMetadata;
}
type PartialAPIMessageInteractionGuildMember = Pick<APIGuildMember, 'avatar' | 'communication_disabled_until' | 'deaf' | 'joined_at' | 'mute' | 'nick' | 'pending' | 'premium_since' | 'roles'>;
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#message-interaction-object}
 */
interface APIMessageInteraction {
  /**
   * ID of the interaction
   */
  id: Snowflake;
  /**
   * The type of interaction
   */
  type: InteractionType;
  /**
   * The name of the application command, including subcommands and subcommand groups
   */
  name: string;
  /**
   * The user who invoked the interaction
   */
  user: APIUser;
  /**
   * The guild member who invoked the interaction, only sent in MESSAGE_CREATE events
   */
  member?: PartialAPIMessageInteractionGuildMember;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
 */
interface APIInteractionGuildMember extends APIGuildMember {
  permissions: Permissions;
  user: APIUser;
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object}
 */
interface APIBaseInteraction<Type extends InteractionType, Data> {
  /**
   * ID of the interaction
   */
  id: Snowflake;
  /**
   * ID of the application this interaction is for
   */
  application_id: Snowflake;
  /**
   * The type of interaction
   */
  type: Type;
  /**
   * The command data payload
   */
  data?: Data;
  /**
   * Guild that the interaction was sent from
   */
  guild?: APIPartialInteractionGuild;
  /**
   * Guild that the interaction was sent from
   */
  guild_id?: Snowflake;
  /**
   * The channel it was sent from
   */
  channel?: Partial<APIChannel> & Pick<APIChannel, 'id' | 'type'>;
  /**
   * The id of the channel it was sent from
   *
   * @deprecated Use {@link APIBaseInteraction.channel} instead
   */
  channel_id?: Snowflake;
  /**
   * Guild member data for the invoking user, including permissions
   *
   * **This is only sent when an interaction is invoked in a guild**
   */
  member?: APIInteractionGuildMember;
  /**
   * User object for the invoking user, if invoked in a DM
   */
  user?: APIUser;
  /**
   * A continuation token for responding to the interaction
   */
  token: string;
  /**
   * Read-only property, always `1`
   */
  version: 1;
  /**
   * For components, the message they were attached to
   */
  message?: APIMessage;
  /**
   * Bitwise set of permissions the app or bot has within the channel the interaction was sent from
   */
  app_permissions: Permissions;
  /**
   * The selected language of the invoking user
   */
  locale: Locale;
  /**
   * The guild's preferred locale, if invoked in a guild
   */
  guild_locale?: Locale;
  /**
   * For monetized apps, any entitlements for the invoking user, representing access to premium SKUs
   */
  entitlements: APIEntitlement[];
  /**
   * Mapping of installation contexts that the interaction was authorized for to related user or guild IDs.
   */
  authorizing_integration_owners: APIAuthorizingIntegrationOwnersMap;
  /**
   * Context where the interaction was triggered from
   */
  context?: InteractionContextType;
  /**
   * Attachment size limit in bytes
   */
  attachment_size_limit: number;
}
type APIAuthorizingIntegrationOwnersMap = { [key in ApplicationIntegrationType]?: Snowflake };
interface APIInteractionDataResolvedChannelBase<T extends ChannelType> extends Required<APIPartialChannel> {
  type: T;
  permissions: Permissions;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/channel#channel-object}
 */
type APIInteractionDataResolvedChannel = APIInteractionDataResolvedChannelBase<Exclude<ChannelType, ThreadChannelType>> | (APIInteractionDataResolvedChannelBase<ThreadChannelType> & Pick<APIThreadChannel, 'parent_id' | 'thread_metadata'>);
/**
 * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
 */
interface APIInteractionDataResolvedGuildMember extends APIBaseGuildMember, APIFlaggedGuildMember, APIGuildMemberAvatar, APIGuildMemberJoined {
  permissions: Permissions;
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-resolved-data-structure}
 */
interface APIInteractionDataResolved {
  users?: Record<Snowflake, APIUser>;
  roles?: Record<Snowflake, APIRole>;
  members?: Record<Snowflake, APIInteractionDataResolvedGuildMember>;
  channels?: Record<Snowflake, APIInteractionDataResolvedChannel>;
  attachments?: Record<Snowflake, APIAttachment>;
}
/**
 * `users` and optional `members` from APIInteractionDataResolved, for user commands and user selects
 */
type APIUserInteractionDataResolved = Pick<APIInteractionDataResolved, 'members'> & Required<Pick<APIInteractionDataResolved, 'users'>>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/shared.d.ts
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-type}
 */
declare enum ApplicationCommandOptionType {
  Subcommand = 1,
  SubcommandGroup = 2,
  String = 3,
  Integer = 4,
  Boolean = 5,
  User = 6,
  Channel = 7,
  Role = 8,
  Mentionable = 9,
  Number = 10,
  Attachment = 11
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-choice-structure}
 */
interface APIApplicationCommandOptionChoice<ValueType = number | string> {
  name: string;
  name_localizations?: LocalizationMap | null;
  value: ValueType;
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/base.d.ts
interface APIApplicationCommandOptionBase<Type extends ApplicationCommandOptionType> {
  type: Type;
  name: string;
  name_localizations?: LocalizationMap | null;
  description: string;
  description_localizations?: LocalizationMap | null;
  required?: boolean;
}
interface APIInteractionDataOptionBase<T extends ApplicationCommandOptionType, D> {
  name: string;
  type: T;
  value: D;
}
type APIApplicationCommandOptionWithAutocompleteOrChoicesWrapper<Base extends APIApplicationCommandOptionBase<ApplicationCommandOptionType>, ChoiceType extends APIApplicationCommandOptionChoice> = (Base & {
  autocomplete: true;
  choices?: [];
}) | (Base & {
  autocomplete?: false;
  choices?: ChoiceType[];
});
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/attachment.d.ts
type APIApplicationCommandAttachmentOption = APIApplicationCommandOptionBase<ApplicationCommandOptionType.Attachment>;
type APIApplicationCommandInteractionDataAttachmentOption = APIInteractionDataOptionBase<ApplicationCommandOptionType.Attachment, Snowflake>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/boolean.d.ts
type APIApplicationCommandBooleanOption = APIApplicationCommandOptionBase<ApplicationCommandOptionType.Boolean>;
type APIApplicationCommandInteractionDataBooleanOption = APIInteractionDataOptionBase<ApplicationCommandOptionType.Boolean, boolean>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/channel.d.ts
interface APIApplicationCommandChannelOption extends APIApplicationCommandOptionBase<ApplicationCommandOptionType.Channel> {
  channel_types?: ApplicationCommandOptionAllowedChannelType[];
}
type APIApplicationCommandInteractionDataChannelOption = APIInteractionDataOptionBase<ApplicationCommandOptionType.Channel, Snowflake>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/integer.d.ts
interface APIApplicationCommandIntegerOptionBase extends APIApplicationCommandOptionBase<ApplicationCommandOptionType.Integer> {
  /**
   * If the option is an `INTEGER` or `NUMBER` type, the minimum value permitted.
   */
  min_value?: number;
  /**
   * If the option is an `INTEGER` or `NUMBER` type, the maximum value permitted.
   */
  max_value?: number;
}
type APIApplicationCommandIntegerOption = APIApplicationCommandOptionWithAutocompleteOrChoicesWrapper<APIApplicationCommandIntegerOptionBase, APIApplicationCommandOptionChoice<number>>;
interface APIApplicationCommandInteractionDataIntegerOption<Type extends InteractionType = InteractionType> extends APIInteractionDataOptionBase<ApplicationCommandOptionType.Integer, Type extends InteractionType.ApplicationCommandAutocomplete ? string : number> {
  focused?: boolean;
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/mentionable.d.ts
type APIApplicationCommandMentionableOption = APIApplicationCommandOptionBase<ApplicationCommandOptionType.Mentionable>;
type APIApplicationCommandInteractionDataMentionableOption = APIInteractionDataOptionBase<ApplicationCommandOptionType.Mentionable, Snowflake>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/number.d.ts
interface APIApplicationCommandNumberOptionBase extends APIApplicationCommandOptionBase<ApplicationCommandOptionType.Number> {
  /**
   * If the option is an `INTEGER` or `NUMBER` type, the minimum value permitted.
   */
  min_value?: number;
  /**
   * If the option is an `INTEGER` or `NUMBER` type, the maximum value permitted.
   */
  max_value?: number;
}
type APIApplicationCommandNumberOption = APIApplicationCommandOptionWithAutocompleteOrChoicesWrapper<APIApplicationCommandNumberOptionBase, APIApplicationCommandOptionChoice<number>>;
interface APIApplicationCommandInteractionDataNumberOption<Type extends InteractionType = InteractionType> extends APIInteractionDataOptionBase<ApplicationCommandOptionType.Number, Type extends InteractionType.ApplicationCommandAutocomplete ? string : number> {
  focused?: boolean;
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/role.d.ts
type APIApplicationCommandRoleOption = APIApplicationCommandOptionBase<ApplicationCommandOptionType.Role>;
type APIApplicationCommandInteractionDataRoleOption = APIInteractionDataOptionBase<ApplicationCommandOptionType.Role, Snowflake>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/string.d.ts
interface APIApplicationCommandStringOptionBase extends APIApplicationCommandOptionBase<ApplicationCommandOptionType.String> {
  /**
   * For option type `STRING`, the minimum allowed length (minimum of `0`, maximum of `6000`).
   */
  min_length?: number;
  /**
   * For option type `STRING`, the maximum allowed length (minimum of `1`, maximum of `6000`).
   */
  max_length?: number;
}
type APIApplicationCommandStringOption = APIApplicationCommandOptionWithAutocompleteOrChoicesWrapper<APIApplicationCommandStringOptionBase, APIApplicationCommandOptionChoice<string>>;
interface APIApplicationCommandInteractionDataStringOption extends APIInteractionDataOptionBase<ApplicationCommandOptionType.String, string> {
  focused?: boolean;
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/subcommand.d.ts
interface APIApplicationCommandSubcommandOption extends APIApplicationCommandOptionBase<ApplicationCommandOptionType.Subcommand> {
  options?: APIApplicationCommandBasicOption[];
}
interface APIApplicationCommandInteractionDataSubcommandOption<Type extends InteractionType = InteractionType> {
  name: string;
  type: ApplicationCommandOptionType.Subcommand;
  options?: APIApplicationCommandInteractionDataBasicOption<Type>[];
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/subcommandGroup.d.ts
interface APIApplicationCommandSubcommandGroupOption extends APIApplicationCommandOptionBase<ApplicationCommandOptionType.SubcommandGroup> {
  options?: APIApplicationCommandSubcommandOption[];
}
interface APIApplicationCommandInteractionDataSubcommandGroupOption<Type extends InteractionType = InteractionType> {
  name: string;
  type: ApplicationCommandOptionType.SubcommandGroup;
  options: APIApplicationCommandInteractionDataSubcommandOption<Type>[];
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/user.d.ts
type APIApplicationCommandUserOption = APIApplicationCommandOptionBase<ApplicationCommandOptionType.User>;
type APIApplicationCommandInteractionDataUserOption = APIInteractionDataOptionBase<ApplicationCommandOptionType.User, Snowflake>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/internals.d.ts
interface APIBaseApplicationCommandInteractionData<Type extends ApplicationCommandType> {
  id: Snowflake;
  type: Type;
  name: string;
  guild_id?: Snowflake;
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/chatInput.d.ts
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-structure}
 */
type APIApplicationCommandBasicOption = APIApplicationCommandAttachmentOption | APIApplicationCommandBooleanOption | APIApplicationCommandChannelOption | APIApplicationCommandIntegerOption | APIApplicationCommandMentionableOption | APIApplicationCommandNumberOption | APIApplicationCommandRoleOption | APIApplicationCommandStringOption | APIApplicationCommandUserOption;
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-structure}
 */
type APIApplicationCommandOption = APIApplicationCommandBasicOption | APIApplicationCommandSubcommandGroupOption | APIApplicationCommandSubcommandOption;
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-interaction-data-option-structure}
 */
type APIApplicationCommandInteractionDataOption<Type extends InteractionType = InteractionType> = APIApplicationCommandInteractionDataBasicOption<Type> | APIApplicationCommandInteractionDataSubcommandGroupOption<Type> | APIApplicationCommandInteractionDataSubcommandOption<Type>;
type APIApplicationCommandInteractionDataBasicOption<Type extends InteractionType = InteractionType> = APIApplicationCommandInteractionDataAttachmentOption | APIApplicationCommandInteractionDataBooleanOption | APIApplicationCommandInteractionDataChannelOption | APIApplicationCommandInteractionDataIntegerOption<Type> | APIApplicationCommandInteractionDataMentionableOption | APIApplicationCommandInteractionDataNumberOption<Type> | APIApplicationCommandInteractionDataRoleOption | APIApplicationCommandInteractionDataStringOption | APIApplicationCommandInteractionDataUserOption;
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-data}
 */
interface APIChatInputApplicationCommandInteractionData extends APIBaseApplicationCommandInteractionData<ApplicationCommandType.ChatInput> {
  options?: APIApplicationCommandInteractionDataOption<InteractionType.ApplicationCommand>[];
  resolved?: APIInteractionDataResolved;
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-data}
 */
interface APIAutocompleteApplicationCommandInteractionData extends APIBaseApplicationCommandInteractionData<ApplicationCommandType.ChatInput> {
  options?: APIApplicationCommandInteractionDataOption<InteractionType.ApplicationCommandAutocomplete>[];
  resolved?: APIInteractionDataResolved;
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object}
 */
type APIChatInputApplicationCommandInteraction = APIApplicationCommandInteractionWrapper<APIChatInputApplicationCommandInteractionData>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/contextMenu.d.ts
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-data}
 */
interface APIUserApplicationCommandInteractionData extends APIBaseApplicationCommandInteractionData<ApplicationCommandType.User> {
  target_id: Snowflake;
  resolved: APIUserInteractionDataResolved;
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-data}
 */
interface APIMessageApplicationCommandInteractionData extends APIBaseApplicationCommandInteractionData<ApplicationCommandType.Message> {
  target_id: Snowflake;
  resolved: APIMessageApplicationCommandInteractionDataResolved;
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-resolved-data-structure}
 */
interface APIMessageApplicationCommandInteractionDataResolved {
  messages: Record<Snowflake, APIMessage>;
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-data}
 */
type APIContextMenuInteractionData = APIMessageApplicationCommandInteractionData | APIUserApplicationCommandInteractionData;
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object}
 */
type APIUserApplicationCommandInteraction = APIApplicationCommandInteractionWrapper<APIUserApplicationCommandInteractionData>;
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object}
 */
type APIMessageApplicationCommandInteraction = APIApplicationCommandInteractionWrapper<APIMessageApplicationCommandInteractionData>;
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object}
 */
type APIContextMenuInteraction = APIMessageApplicationCommandInteraction | APIUserApplicationCommandInteraction;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/entryPoint.d.ts
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-data}
 */
type APIPrimaryEntryPointCommandInteractionData = APIBaseApplicationCommandInteractionData<ApplicationCommandType.PrimaryEntryPoint>;
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object}
 */
type APIPrimaryEntryPointCommandInteraction = APIApplicationCommandInteractionWrapper<APIPrimaryEntryPointCommandInteractionData>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/permissions.d.ts
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-permissions-object-application-command-permissions-structure}
 */
interface APIApplicationCommandPermission {
  /**
   * The id of the role, user or channel. Can also be a permission constant
   */
  id: Snowflake;
  /**
   * Role, user or channel
   */
  type: ApplicationCommandPermissionType;
  /**
   * `true` to allow, `false`, to disallow
   */
  permission: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-permissions-object-application-command-permission-type}
 */
declare enum ApplicationCommandPermissionType {
  Role = 1,
  User = 2,
  Channel = 3
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/applicationCommands.d.ts
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-object}
 */
interface APIApplicationCommand {
  /**
   * Unique id of the command
   */
  id: Snowflake;
  /**
   * Type of the command
   */
  type: ApplicationCommandType;
  /**
   * Unique id of the parent application
   */
  application_id: Snowflake;
  /**
   * Guild id of the command, if not global
   */
  guild_id?: Snowflake;
  /**
   * 1-32 character name; `CHAT_INPUT` command names must be all lowercase matching `^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$`
   */
  name: string;
  /**
   * Localization dictionary for the name field. Values follow the same restrictions as name
   */
  name_localizations?: LocalizationMap | null;
  /**
   * The localized name
   */
  name_localized?: string;
  /**
   * 1-100 character description for `CHAT_INPUT` commands, empty string for `USER` and `MESSAGE` commands
   */
  description: string;
  /**
   * Localization dictionary for the description field. Values follow the same restrictions as description
   */
  description_localizations?: LocalizationMap | null;
  /**
   * The localized description
   */
  description_localized?: string;
  /**
   * The parameters for the `CHAT_INPUT` command, max 25
   */
  options?: APIApplicationCommandOption[];
  /**
   * Set of permissions represented as a bitset
   */
  default_member_permissions: Permissions | null;
  /**
   * Indicates whether the command is available in DMs with the app, only for globally-scoped commands. By default, commands are visible
   *
   * @deprecated Use {@link APIApplicationCommand.contexts} instead
   */
  dm_permission?: boolean;
  /**
   * Whether the command is enabled by default when the app is added to a guild
   *
   * If missing, this property should be assumed as `true`
   *
   * @deprecated Use {@link APIApplicationCommand.dm_permission} and/or {@link APIApplicationCommand.default_member_permissions} instead
   */
  default_permission?: boolean;
  /**
   * Indicates whether the command is age-restricted
   *
   * @defaultValue `false`
   */
  nsfw?: boolean;
  /**
   * Installation context(s) where the command is available, only for globally-scoped commands
   *
   * @defaultValue `[ApplicationIntegrationType.GuildInstall]`
   */
  integration_types?: ApplicationIntegrationType[];
  /**
   * Interaction context(s) where the command can be used, only for globally-scoped commands
   *
   * @defaultValue `[InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel]`
   */
  contexts?: InteractionContextType[] | null;
  /**
   * Autoincrementing version identifier updated during substantial record changes
   */
  version: Snowflake;
  /**
   * Determines whether the interaction is handled by the app's interactions handler or by Discord
   *
   * @remarks
   * This is only available for {@link ApplicationCommandType.PrimaryEntryPoint} commands
   */
  handler?: EntryPointCommandHandlerType;
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-types}
 */
declare enum ApplicationCommandType {
  /**
   * Slash commands; a text-based command that shows up when a user types `/`
   */
  ChatInput = 1,
  /**
   * A UI-based command that shows up when you right click or tap on a user
   */
  User = 2,
  /**
   * A UI-based command that shows up when you right click or tap on a message
   */
  Message = 3,
  /**
   * A UI-based command that represents the primary way to invoke an app's Activity
   */
  PrimaryEntryPoint = 4
}
/**
 * @see {@link https://discord.com/developers/docs/resources/application#application-object-application-integration-types}
 */
declare enum ApplicationIntegrationType {
  /**
   * App is installable to servers
   */
  GuildInstall = 0,
  /**
   * App is installable to users
   */
  UserInstall = 1
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-context-types}
 */
declare enum InteractionContextType {
  /**
   * Interaction can be used within servers
   */
  Guild = 0,
  /**
   * Interaction can be used within DMs with the app's bot user
   */
  BotDM = 1,
  /**
   * Interaction can be used within Group DMs and DMs other than the app's bot user
   */
  PrivateChannel = 2
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-object-entry-point-command-handler-types}
 */
declare enum EntryPointCommandHandlerType {
  /**
   * The app handles the interaction using an interaction token
   */
  AppHandler = 1,
  /**
   * Discord handles the interaction by launching an Activity and sending a follow-up message without coordinating with
   * the app
   */
  DiscordLaunchActivity = 2
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-data}
 */
type APIApplicationCommandInteractionData = APIChatInputApplicationCommandInteractionData | APIContextMenuInteractionData | APIPrimaryEntryPointCommandInteractionData;
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object}
 */
type APIApplicationCommandInteractionWrapper<Data extends APIApplicationCommandInteractionData> = APIBaseInteraction<InteractionType.ApplicationCommand, Data> & Required<Pick<APIBaseInteraction<InteractionType.ApplicationCommand, Data>, 'app_permissions' | 'channel_id' | 'channel' | 'data'>>;
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object}
 */
type APIApplicationCommandInteraction = APIChatInputApplicationCommandInteraction | APIContextMenuInteraction | APIPrimaryEntryPointCommandInteraction;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/autocomplete.d.ts
type APIApplicationCommandAutocompleteInteraction = APIBaseInteraction<InteractionType.ApplicationCommandAutocomplete, APIAutocompleteApplicationCommandInteractionData> & Required<Pick<APIBaseInteraction<InteractionType.ApplicationCommandAutocomplete, Required<Pick<APIAutocompleteApplicationCommandInteractionData, 'options'>>>, 'data'>>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/messageComponents.d.ts
type APIMessageComponentInteraction = APIBaseInteraction<InteractionType.MessageComponent, APIMessageComponentInteractionData> & Required<Pick<APIBaseInteraction<InteractionType.MessageComponent, APIMessageComponentInteractionData>, 'app_permissions' | 'channel_id' | 'channel' | 'data' | 'message'>>;
type APIMessageComponentInteractionData = APIMessageButtonInteractionData | APIMessageSelectMenuInteractionData;
interface APIMessageComponentBaseInteractionData<CType extends ComponentType> {
  /**
   * The `custom_id` of the component
   */
  custom_id: string;
  /**
   * The type of the component
   */
  component_type: CType;
}
type APIMessageButtonInteractionData = APIMessageComponentBaseInteractionData<ComponentType.Button>;
interface APIMessageStringSelectInteractionData extends APIMessageComponentBaseInteractionData<ComponentType.StringSelect> {
  values: string[];
}
interface APIMessageUserSelectInteractionData extends APIMessageComponentBaseInteractionData<ComponentType.UserSelect> {
  values: Snowflake[];
  resolved: APIUserInteractionDataResolved;
}
interface APIMessageRoleSelectInteractionData extends APIMessageComponentBaseInteractionData<ComponentType.RoleSelect> {
  values: Snowflake[];
  resolved: Required<Pick<APIInteractionDataResolved, 'roles'>>;
}
interface APIMessageMentionableSelectInteractionData extends APIMessageComponentBaseInteractionData<ComponentType.MentionableSelect> {
  values: Snowflake[];
  resolved: Pick<APIInteractionDataResolved, 'members' | 'roles' | 'users'>;
}
interface APIMessageChannelSelectInteractionData extends APIMessageComponentBaseInteractionData<ComponentType.ChannelSelect> {
  values: Snowflake[];
  resolved: Required<Pick<APIInteractionDataResolved, 'channels'>>;
}
type APIMessageSelectMenuInteractionData = APIMessageChannelSelectInteractionData | APIMessageMentionableSelectInteractionData | APIMessageRoleSelectInteractionData | APIMessageStringSelectInteractionData | APIMessageUserSelectInteractionData;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/modalSubmit.d.ts
interface APIBaseModalSubmitComponent<T extends ComponentType> extends APIBaseComponent<T> {
  custom_id: string;
}
interface APIModalSubmitTextInputComponent extends APIBaseModalSubmitComponent<ComponentType.TextInput> {
  value: string;
}
interface APIModalSubmitStringSelectComponent extends APIBaseModalSubmitComponent<ComponentType.StringSelect> {
  values: string[];
}
interface APIModalSubmitUserSelectComponent extends APIBaseModalSubmitComponent<ComponentType.UserSelect> {
  values: string[];
}
interface APIModalSubmitRoleSelectComponent extends APIBaseModalSubmitComponent<ComponentType.RoleSelect> {
  values: string[];
}
interface APIModalSubmitMentionableSelectComponent extends APIBaseModalSubmitComponent<ComponentType.MentionableSelect> {
  values: string[];
}
interface APIModalSubmitChannelSelectComponent extends APIBaseModalSubmitComponent<ComponentType.ChannelSelect> {
  values: string[];
}
interface APIModalSubmitFileUploadComponent extends APIBaseModalSubmitComponent<ComponentType.FileUpload> {
  values: string[];
}
interface APIModalSubmitRadioGroupComponent extends APIBaseModalSubmitComponent<ComponentType.RadioGroup> {
  value: string | null;
}
interface APIModalSubmitCheckboxGroupComponent extends APIBaseModalSubmitComponent<ComponentType.CheckboxGroup> {
  values: string[];
}
interface APIModalSubmitCheckboxComponent extends APIBaseModalSubmitComponent<ComponentType.Checkbox> {
  value: boolean;
}
type ModalSubmitComponent = APIModalSubmitChannelSelectComponent | APIModalSubmitCheckboxComponent | APIModalSubmitCheckboxGroupComponent | APIModalSubmitFileUploadComponent | APIModalSubmitMentionableSelectComponent | APIModalSubmitRadioGroupComponent | APIModalSubmitRoleSelectComponent | APIModalSubmitStringSelectComponent | APIModalSubmitTextInputComponent | APIModalSubmitUserSelectComponent;
interface ModalSubmitActionRowComponent extends APIBaseComponent<ComponentType.ActionRow> {
  components: APIModalSubmitTextInputComponent[];
}
interface ModalSubmitTextDisplayComponent extends APIBaseComponent<ComponentType.TextDisplay> {}
interface ModalSubmitLabelComponent extends APIBaseComponent<ComponentType.Label> {
  component: ModalSubmitComponent;
}
type APIModalSubmissionComponent = ModalSubmitActionRowComponent | ModalSubmitLabelComponent | ModalSubmitTextDisplayComponent;
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-modal-submit-data-structure}
 */
interface APIModalSubmission {
  /**
   * Data for users, members, channels, and roles in the modal's auto-populated select menus
   *
   * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-resolved-data-structure}
   */
  resolved?: APIInteractionDataResolved;
  /**
   * A developer-defined identifier for the component, max 100 characters
   */
  custom_id: string;
  /**
   * A list of child components
   */
  components: APIModalSubmissionComponent[];
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object}
 */
type APIModalSubmitInteraction = APIBaseInteraction<InteractionType.ModalSubmit, APIModalSubmission> & Required<Pick<APIBaseInteraction<InteractionType.ModalSubmit, APIModalSubmission>, 'data'>>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/ping.d.ts
type APIPingInteraction = Omit<APIBaseInteraction<InteractionType.Ping, never>, 'locale'>;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/interactions.d.ts
/**
 * @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object}
 */
type APIInteraction = APIApplicationCommandAutocompleteInteraction | APIApplicationCommandInteraction | APIMessageComponentInteraction | APIModalSubmitInteraction | APIPingInteraction;
//#endregion
//#region node_modules/discord-api-types/payloads/v10/teams.d.ts
/**
 * @see {@link https://discord.com/developers/docs/topics/teams#data-models-team-object}
 */
interface APITeam {
  /**
   * A hash of the image of the team's icon
   */
  icon: string | null;
  /**
   * The unique id of the team
   */
  id: Snowflake;
  /**
   * The members of the team
   */
  members: APITeamMember[];
  /**
   * The name of the team
   */
  name: string;
  /**
   * The user id of the current team owner
   */
  owner_user_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/teams#data-models-team-member-object}
 */
interface APITeamMember {
  /**
   * The user's membership state on the team
   *
   * @see {@link https://discord.com/developers/docs/topics/teams#data-models-membership-state-enum}
   */
  membership_state: TeamMemberMembershipState;
  /**
   * Will always be `["*"]`
   *
   * @deprecated Use {@link APITeamMember.role} instead.
   */
  permissions: ['*'];
  /**
   * The id of the parent team of which they are a member
   */
  team_id: Snowflake;
  /**
   * The avatar, discriminator, id, and username of the user
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  user: APIUser;
  /**
   * The user's role in the team.
   *
   * @see {@link https://discord.com/developers/docs/topics/teams#team-member-roles}
   */
  role: TeamMemberRole;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/teams#data-models-membership-state-enum}
 */
declare enum TeamMemberMembershipState {
  Invited = 1,
  Accepted = 2
}
/**
 * @see {@link https://discord.com/developers/docs/topics/teams#team-member-roles-team-member-role-types}
 */
declare enum TeamMemberRole {
  Admin = "admin",
  Developer = "developer",
  ReadOnly = "read_only"
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/webhook.d.ts
/**
 * @see {@link https://discord.com/developers/docs/events/webhook-events#event-types}
 */
declare enum ApplicationWebhookEventType {
  /**
   * Sent when an app was authorized by a user to a server or their account
   */
  ApplicationAuthorized = "APPLICATION_AUTHORIZED",
  /**
   * Sent when an app was deauthorized by a user
   */
  ApplicationDeauthorized = "APPLICATION_DEAUTHORIZED",
  /**
   * Entitlement was created
   */
  EntitlementCreate = "ENTITLEMENT_CREATE",
  /**
   * Entitlement was updated
   */
  EntitlementUpdate = "ENTITLEMENT_UPDATE",
  /**
   * Entitlement was deleted
   */
  EntitlementDelete = "ENTITLEMENT_DELETE",
  /**
   * User was added to a Quest (currently unavailable)
   */
  QuestUserEnrollment = "QUEST_USER_ENROLLMENT"
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/application.d.ts
/**
 * @see {@link https://discord.com/developers/docs/resources/application#application-object}
 */
interface APIApplication {
  /**
   * The id of the app
   */
  id: Snowflake;
  /**
   * The name of the app
   */
  name: string;
  /**
   * The icon hash of the app
   */
  icon: string | null;
  /**
   * The description of the app
   */
  description: string;
  /**
   * An array of rpc origin urls, if rpc is enabled
   */
  rpc_origins?: string[];
  /**
   * When `false` only app owner can join the app's bot to guilds
   */
  bot_public: boolean;
  /**
   * When `true` the app's bot will only join upon completion of the full oauth2 code grant flow
   */
  bot_require_code_grant: boolean;
  /**
   * Partial user object for the bot user associated with the application
   */
  bot?: APIUser;
  /**
   * The url of the application's terms of service
   */
  terms_of_service_url?: string;
  /**
   * The url of the application's privacy policy
   */
  privacy_policy_url?: string;
  /**
   * Partial user object containing info on the owner of the application
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  owner?: APIUser;
  /**
   * An empty string
   *
   * @deprecated This field will be removed in v11
   * @unstable This field is no longer documented by Discord and will be removed in v11
   */
  summary: '';
  /**
   * The hexadecimal encoded key for verification in interactions and the GameSDK's GetTicket function
   *
   * @see {@link https://discord.com/developers/docs/game-sdk/applications#getticket}
   */
  verify_key: string;
  /**
   * The team this application belongs to
   *
   * @see {@link https://discord.com/developers/docs/topics/teams#data-models-team-object}
   */
  team: APITeam | null;
  /**
   * If this application is a game sold on Discord, this field will be the guild to which it has been linked
   */
  guild_id?: Snowflake;
  /**
   * A partial object of the associated guild
   */
  guild?: APIPartialGuild;
  /**
   * If this application is a game sold on Discord, this field will be the id of the "Game SKU" that is created, if exists
   */
  primary_sku_id?: Snowflake;
  /**
   * If this application is a game sold on Discord, this field will be the URL slug that links to the store page
   */
  slug?: string;
  /**
   * If this application is a game sold on Discord, this field will be the hash of the image on store embeds
   */
  cover_image?: string;
  /**
   * The application's public flags
   *
   * @see {@link https://discord.com/developers/docs/resources/application#application-object-application-flags}
   */
  flags: ApplicationFlags;
  /**
   * Approximate count of guilds the application has been added to
   */
  approximate_guild_count?: number;
  /**
   * Approximate count of users that have installed the app (authorized with `application.commands` as a scope)
   */
  approximate_user_install_count?: number;
  /**
   * Approximate count of users that have OAuth2 authorizations for the app
   */
  approximate_user_authorization_count?: number;
  /**
   * Array of redirect URIs for the application
   */
  redirect_uris?: string[];
  /**
   * The interactions endpoint URL for the application
   */
  interactions_endpoint_url?: string | null;
  /**
   * The application's role connection verification entry point,
   * which when configured will render the app as a verification method in the guild role verification configuration
   */
  role_connections_verification_url?: string | null;
  /**
   * Up to 5 tags of max 20 characters each describing the content and functionality of the application
   */
  tags?: [string, string?, string?, string?, string?];
  /**
   * Settings for the application's default in-app authorization link, if enabled
   */
  install_params?: APIApplicationInstallParams;
  /**
   * Default scopes and permissions for each supported installation context. Value for each key is an integration type configuration object
   */
  integration_types_config?: APIApplicationIntegrationTypesConfigMap;
  /**
   * The application's default custom authorization link, if enabled
   */
  custom_install_url?: string;
  /**
   * Event webhook URL for the app to receive webhook events
   */
  event_webhooks_url?: string | null;
  /**
   * If webhook events are enabled for the app
   */
  event_webhooks_status?: ApplicationWebhookEventStatus;
  /**
   * List of webhook event types the app subscribes to
   */
  event_webhooks_types?: ApplicationWebhookEventType[];
}
interface APIApplicationInstallParams {
  scopes: OAuth2Scopes[];
  permissions: Permissions;
}
interface APIApplicationIntegrationTypeConfiguration {
  oauth2_install_params?: APIApplicationInstallParams;
}
type APIApplicationIntegrationTypesConfigMap = { [key in ApplicationIntegrationType]?: APIApplicationIntegrationTypeConfiguration };
/**
 * @see {@link https://discord.com/developers/docs/resources/application#application-object-application-flags}
 */
declare enum ApplicationFlags {
  /**
   * @unstable This application flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  EmbeddedReleased = 2,
  /**
   * @unstable This application flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  ManagedEmoji = 4,
  /**
   * @unstable This application flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  EmbeddedIAP = 8,
  /**
   * @unstable This application flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  GroupDMCreate = 16,
  /**
   * Indicates if an app uses the Auto Moderation API
   */
  ApplicationAutoModerationRuleCreateBadge = 64,
  /**
   * @unstable This application flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  RPCHasConnected = 2048,
  /**
   * Intent required for bots in 100 or more servers to receive `presence_update` events
   */
  GatewayPresence = 4096,
  /**
   * Intent required for bots in under 100 servers to receive `presence_update` events, found in Bot Settings
   */
  GatewayPresenceLimited = 8192,
  /**
   * Intent required for bots in 100 or more servers to receive member-related events like `guild_member_add`.
   *
   * @see List of member-related events {@link https://discord.com/developers/docs/topics/gateway#list-of-intents | under `GUILD_MEMBERS`}
   */
  GatewayGuildMembers = 16384,
  /**
   * Intent required for bots in under 100 servers to receive member-related events like `guild_member_add`, found in Bot Settings.
   *
   * @see List of member-related events {@link https://discord.com/developers/docs/topics/gateway#list-of-intents | under `GUILD_MEMBERS`}
   */
  GatewayGuildMembersLimited = 32768,
  /**
   * Indicates unusual growth of an app that prevents verification
   */
  VerificationPendingGuildLimit = 65536,
  /**
   * Indicates if an app is embedded within the Discord client (currently unavailable publicly)
   */
  Embedded = 131072,
  /**
   * Intent required for bots in 100 or more servers to receive {@link https://support-dev.discord.com/hc/articles/6207308062871 | message content}
   */
  GatewayMessageContent = 262144,
  /**
   * Intent required for bots in under 100 servers to receive {@link https://support-dev.discord.com/hc/articles/6207308062871 | message content},
   * found in Bot Settings
   */
  GatewayMessageContentLimited = 524288,
  /**
   * @unstable This application flag is currently not documented by Discord but has a known value which we will try to keep up to date.
   */
  EmbeddedFirstParty = 1048576,
  /**
   * Indicates if an app has registered global {@link https://discord.com/developers/docs/interactions/application-commands | application commands}
   */
  ApplicationCommandBadge = 8388608
}
/**
 * @see {@link https://discord.com/developers/docs/resources/application#application-object-application-event-webhook-status}
 */
declare enum ApplicationWebhookEventStatus {
  /**
   * Webhook events are disabled by developer
   */
  Disabled = 1,
  /**
   * Webhook events are enabled by developer
   */
  Enabled = 2,
  /**
   * Webhook events are disabled by Discord, usually due to inactivity
   */
  DisabledByDiscord = 3
}
//#endregion
//#region extensions/discord/src/internal/embeds.d.ts
declare class Embed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: APIEmbed["footer"];
  image?: string | APIEmbed["image"];
  thumbnail?: string | APIEmbed["thumbnail"];
  author?: APIEmbed["author"];
  fields?: APIEmbed["fields"];
  constructor(embed?: APIEmbed);
  serialize(): APIEmbed;
}
//#endregion
//#region extensions/discord/src/internal/payload.d.ts
type MessagePayloadFile = {
  name: string;
  data: Blob | Uint8Array | ArrayBuffer;
  description?: string;
  duration_secs?: number;
  waveform?: string;
};
type MessagePayloadObject = {
  content?: string;
  embeds?: Array<APIEmbed | Embed>;
  components?: TopLevelComponents[];
  allowedMentions?: unknown;
  allowed_mentions?: unknown;
  flags?: number;
  tts?: boolean;
  files?: MessagePayloadFile[];
  poll?: unknown;
  ephemeral?: boolean;
  stickers?: [string, string, string] | [string, string] | [string];
};
type MessagePayload = string | MessagePayloadObject;
type TopLevelComponents = {
  isV2?: boolean;
  serialize: () => unknown;
};
//#endregion
export { GatewayPresenceUpdate as $, APIBaseGuildMember as A, APIUnavailableGuild as B, APIMessageReference as C, VideoQualityMode as Ct, MessageType as D, _AddUndefinedToPossiblyUndefinedPropertiesOfInterface as Dt, ComponentType as E, APIRole as Et, APIGuildIntegrationType as F, GuildVerificationLevel as G, GuildExplicitContentFilter as H, APIGuildMember as I, APIStickerItem as J, IntegrationExpireBehavior as K, APIGuildMemberAvatar as L, APIFlaggedGuildMember as M, APIGuild as N, TextInputStyle as O, _NonNullableFields as Ot, APIGuildIntegration as P, GatewayGuildMembersChunkPresence as Q, APIGuildMemberJoined as R, APIMessage as S, ThreadChannelType as St, APITextInputComponent as T, APIUser as Tt, GuildMFALevel as U, GuildDefaultMessageNotifications as V, GuildSystemChannelFlags as W, APIGatewayBotInfo as X, StickerFormatType as Y, GatewayActivity as Z, APIEntitlement as _, APITextChannel as _t, APIInteraction as a, APIGroupDMChannel as at, APIBaseMessage as b, ChannelType as bt, APIApplicationCommandInteraction as c, APIGuildForumDefaultReactionEmoji as ct, APIApplicationCommandPermission as d, APIGuildStageVoiceChannel as dt, GatewayThreadListSync as et, APIApplicationCommandInteractionDataBasicOption as f, APIGuildVoiceChannel as ft, InteractionResponseType as g, APIPublicThreadChannel as gt, APIInteractionDataResolvedChannel as h, APIPrivateThreadChannel as ht, APIApplication as i, APIChannel as it, APIBaseVoiceGuildMember as j, APIBaseGuild as k, Snowflake as kt, ApplicationCommandType as l, APIGuildForumTag as lt, ApplicationCommandOptionType as m, APIOverwrite as mt, TopLevelComponents as n, PresenceUpdateStatus as nt, APIMessageComponentInteraction as o, APIGuildCategoryChannel as ot, APIApplicationCommandInteractionDataOption as p, APINewsChannel as pt, APISticker as q, Embed as r, APIAnnouncementThreadChannel as rt, APIApplicationCommand as s, APIGuildForumChannel as st, MessagePayload as t, GatewayThreadMembersUpdate as tt, InteractionContextType as u, APIGuildMediaChannel as ut, APISubscription as v, APIThreadChannel as vt, APITextDisplayComponent as w, APIEmoji as wt, APIEmbed as x, GuildChannelType as xt, APIAttachment as y, APIThreadMember as yt, APIGuildMemberUser as z };