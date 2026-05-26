/// <reference types="node" />
import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { T as ReplyToMode } from "./types.base-DS--yneR.js";
import { Et as DiscordIntentsConfig, _t as DiscordAccountConfig } from "./types.channels-C67UBRPK.js";
import { n as InboundEventKind } from "./input-provenance-DgsxhTbk.js";
import { t as HistoryEntry } from "./history.types-D_WxL2c8.js";
import { n as RuntimeEnv$1 } from "./runtime-Bxifh4bY.js";
import { n as ChannelRuntimeSurface } from "./channel-runtime-surface.types-gKXwaxDV.js";
import { l as NativeCommandSpec } from "./commands-registry.types-B-WfTzT-.js";
import { c as SessionBindingRecord } from "./session-binding.types-cd2c9es6.js";
import { o as resolveAgentRoute } from "./resolve-route-BZP_W0Z9.js";
import { M as ChannelBotLoopProtectionFacts } from "./types-C4IQ1Uoz.js";
import { n as ChannelMatchSource } from "./channel-config-SOo4scvx.js";
import { u as ThreadBindingManager } from "./thread-bindings.manager-BHR-9Y46.js";
import { $ as GatewayPresenceUpdate, A as APIBaseGuildMember, B as APIUnavailableGuild, Ct as VideoQualityMode, Dt as _AddUndefinedToPossiblyUndefinedPropertiesOfInterface, Et as APIRole, F as APIGuildIntegrationType, G as GuildVerificationLevel, H as GuildExplicitContentFilter, I as APIGuildMember, K as IntegrationExpireBehavior, L as APIGuildMemberAvatar, M as APIFlaggedGuildMember, N as APIGuild, Ot as _NonNullableFields, P as APIGuildIntegration, Q as GatewayGuildMembersChunkPresence, R as APIGuildMemberJoined, St as ThreadChannelType, Tt as APIUser, U as GuildMFALevel, V as GuildDefaultMessageNotifications, W as GuildSystemChannelFlags, X as APIGatewayBotInfo, Y as StickerFormatType, Z as GatewayActivity, _ as APIEntitlement, _t as APITextChannel, a as APIInteraction, at as APIGroupDMChannel, b as APIBaseMessage, bt as ChannelType, ct as APIGuildForumDefaultReactionEmoji, d as APIApplicationCommandPermission, dt as APIGuildStageVoiceChannel, et as GatewayThreadListSync, ft as APIGuildVoiceChannel, gt as APIPublicThreadChannel, ht as APIPrivateThreadChannel, i as APIApplication, it as APIChannel, j as APIBaseVoiceGuildMember, k as APIBaseGuild, kt as Snowflake, l as ApplicationCommandType, lt as APIGuildForumTag, m as ApplicationCommandOptionType, mt as APIOverwrite, nt as PresenceUpdateStatus, ot as APIGuildCategoryChannel, pt as APINewsChannel, q as APISticker, rt as APIAnnouncementThreadChannel, s as APIApplicationCommand, st as APIGuildForumChannel, tt as GatewayThreadMembersUpdate, u as InteractionContextType, ut as APIGuildMediaChannel, v as APISubscription, vt as APIThreadChannel, wt as APIEmoji, xt as GuildChannelType, yt as APIThreadMember, z as APIGuildMemberUser } from "./payload-U2icqU80.js";
import { a as APIGuildScheduledEventRecurrenceRule, c as GuildScheduledEventStatus, n as APIVoiceState, o as GuildScheduledEventEntityType, r as APIGuildScheduledEvent, t as APIBaseVoiceState } from "./voice-Damkqy6G.js";
import { n as RequestClientOptions, t as RequestClient } from "./rest-CE8PF7Nu.js";
import { c as AutocompleteInteraction, d as Message, f as User, i as BaseMessageInteractiveComponent, l as Guild, n as Modal, s as parseCustomId, u as GuildMember } from "./components.modal-F1ooc12a.js";
import * as ws from "ws";
import { EventEmitter } from "node:events";
import { Duplex } from "stream";
import { URL } from "url";
import * as tls from "tls";
import * as net from "net";
import * as http from "http";
import { OutgoingHttpHeaders } from "http";

//#region node_modules/discord-api-types/payloads/v10/autoModeration.d.ts
/**
 * @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-auto-moderation-rule-structure}
 */
interface APIAutoModerationRule {
  /**
   * The id of this rule
   */
  id: Snowflake;
  /**
   * The guild which this rule belongs to
   */
  guild_id: Snowflake;
  /**
   * The rule name
   */
  name: string;
  /**
   * The user id who created this rule
   */
  creator_id: Snowflake;
  /**
   * The rule event type
   */
  event_type: AutoModerationRuleEventType;
  /**
   * The rule trigger type
   */
  trigger_type: AutoModerationRuleTriggerType;
  /**
   * The rule trigger metadata
   */
  trigger_metadata: APIAutoModerationRuleTriggerMetadata;
  /**
   * The actions which will execute when this rule is triggered
   */
  actions: APIAutoModerationAction[];
  /**
   * Whether this rule is enabled
   */
  enabled: boolean;
  /**
   * The role ids that shouldn't be affected by this rule (Maximum of 20)
   */
  exempt_roles: Snowflake[];
  /**
   * The channel ids that shouldn't be affected by this rule (Maximum of 50)
   */
  exempt_channels: Snowflake[];
}
/**
 * @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-trigger-types}
 */
declare enum AutoModerationRuleTriggerType {
  /**
   * Check if content contains words from a user defined list of keywords (Maximum of 6 per guild)
   */
  Keyword = 1,
  /**
   * Check if content represents generic spam (Maximum of 1 per guild)
   */
  Spam = 3,
  /**
   * Check if content contains words from internal pre-defined wordsets (Maximum of 1 per guild)
   */
  KeywordPreset = 4,
  /**
   * Check if content contains more mentions than allowed (Maximum of 1 per guild)
   */
  MentionSpam = 5,
  /**
   * Check if member profile contains words from a user defined list of keywords (Maximum of 1 per guild)
   */
  MemberProfile = 6
}
/**
 * @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-trigger-metadata}
 */
interface APIAutoModerationRuleTriggerMetadata {
  /**
   * Substrings which will be searched for in content (Maximum of 1000)
   *
   * A keyword can be a phrase which contains multiple words. Wildcard symbols can be used to customize how each string will be matched. Each keyword must be 60 characters or less
   *
   * @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-keyword-matching-strategies | Keyword matching strategies}
   *
   * Associated trigger types: {@link AutoModerationRuleTriggerType.Keyword}, {@link AutoModerationRuleTriggerType.MemberProfile}
   */
  keyword_filter?: string[];
  /**
   * The internally pre-defined wordsets which will be searched for in content
   *
   * Associated trigger type: {@link AutoModerationRuleTriggerType.KeywordPreset}
   */
  presets?: AutoModerationRuleKeywordPresetType[];
  /**
   * Substrings which will be exempt from triggering the preset trigger type (Maximum of 1000)
   *
   * A allowed-word can be a phrase which contains multiple words. Wildcard symbols can be used to customize how each string will be matched. Each keyword must be 60 characters or less
   *
   * @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-keyword-matching-strategies | Keyword matching strategies}
   *
   * Associated trigger types: {@link AutoModerationRuleTriggerType.Keyword}, {@link AutoModerationRuleTriggerType.KeywordPreset}, {@link AutoModerationRuleTriggerType.MemberProfile}
   */
  allow_list?: string[];
  /**
   * Regular expression patterns which will be matched against content (Maximum of 10)
   *
   * Only Rust flavored regex is currently supported (Maximum of 260 characters)
   *
   * Associated trigger types: {@link AutoModerationRuleTriggerType.Keyword}, {@link AutoModerationRuleTriggerType.MemberProfile}
   */
  regex_patterns?: string[];
  /**
   * Total number of mentions (role & user) allowed per message (Maximum of 50)
   *
   * Associated trigger type: {@link AutoModerationRuleTriggerType.MentionSpam}
   */
  mention_total_limit?: number;
  /**
   * Whether to automatically detect mention raids
   *
   * Associated trigger type: {@link AutoModerationRuleTriggerType.MentionSpam}
   */
  mention_raid_protection_enabled?: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-keyword-preset-types}
 */
declare enum AutoModerationRuleKeywordPresetType {
  /**
   * Words that may be considered forms of swearing or cursing
   */
  Profanity = 1,
  /**
   * Words that refer to sexually explicit behavior or activity
   */
  SexualContent = 2,
  /**
   * Personal insults or words that may be considered hate speech
   */
  Slurs = 3
}
/**
 * @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-event-types}
 */
declare enum AutoModerationRuleEventType {
  /**
   * When a member sends or edits a message in the guild
   */
  MessageSend = 1,
  /**
   * When a member edits their profile
   */
  MemberUpdate = 2
}
/**
 * @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-action-object-auto-moderation-action-structure}
 */
interface APIAutoModerationAction {
  /**
   * The action type
   */
  type: AutoModerationActionType;
  /**
   * Additional metadata needed during execution for this specific action type
   *
   * Will only be omitted if the action type is {@link AutoModerationActionType.BlockMessage}
   */
  metadata?: APIAutoModerationActionMetadata;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-action-object-action-types}
 */
declare enum AutoModerationActionType {
  /**
   * Blocks a member's message and prevents it from being posted.
   * A custom explanation can be specified and shown to members whenever their message is blocked
   */
  BlockMessage = 1,
  /**
   * Logs user content to a specified channel
   */
  SendAlertMessage = 2,
  /**
   * Timeout user for specified duration, this action type can be set if the bot has `MODERATE_MEMBERS` permission
   */
  Timeout = 3,
  /**
   * Prevents a member from using text, voice, or other interactions
   */
  BlockMemberInteraction = 4
}
/**
 * @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-action-object-action-metadata}
 */
interface APIAutoModerationActionMetadata {
  /**
   * Channel to which user content should be logged
   *
   * Associated action type: {@link AutoModerationActionType.SendAlertMessage}
   */
  channel_id?: Snowflake;
  /**
   * Timeout duration in seconds (Maximum of 4 weeks - 2419200 seconds)
   *
   * Only available if using {@link AutoModerationRuleTriggerType.Keyword}
   *
   * Associated action type: {@link AutoModerationActionType.Timeout}
   */
  duration_seconds?: number;
  /**
   * Additional explanation that will be shown to members whenever their message is blocked (Maximum 150 characters)
   *
   * Associated action type {@link AutoModerationActionType.BlockMessage}
   */
  custom_message?: string;
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/stageInstance.d.ts
/**
 * @see {@link https://discord.com/developers/docs/resources/stage-instance#stage-instance-object}
 */
interface APIStageInstance {
  /**
   * The id of the stage instance
   */
  id: Snowflake;
  /**
   * The guild id of the associated stage channel
   */
  guild_id: Snowflake;
  /**
   * The id of the associated stage channel
   */
  channel_id: Snowflake;
  /**
   * The topic of the stage instance (1-120 characters)
   */
  topic: string;
  /**
   * The privacy level of the stage instance
   *
   * @see {@link https://discord.com/developers/docs/resources/stage-instance#stage-instance-object-privacy-level}
   */
  privacy_level: StageInstancePrivacyLevel;
  /**
   * Whether or not stage discovery is disabled
   *
   * @deprecated
   * {@link https://github.com/discord/discord-api-docs/pull/4296 | discord-api-docs#4296}
   */
  discoverable_disabled: boolean;
  /**
   * The id of the scheduled event for this stage instance
   */
  guild_scheduled_event_id?: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/stage-instance#stage-instance-object-privacy-level}
 */
declare enum StageInstancePrivacyLevel {
  /**
   * The stage instance is visible publicly, such as on stage discovery
   *
   * @deprecated
   * {@link https://github.com/discord/discord-api-docs/pull/4296 | discord-api-docs#4296}
   */
  Public = 1,
  /**
   * The stage instance is visible to only guild members
   */
  GuildOnly = 2
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/auditLog.d.ts
/**
 * @see {@link https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-entry-structure}
 */
interface APIAuditLogEntry {
  /**
   * ID of the affected entity (webhook, user, role, etc.)
   */
  target_id: string | null;
  /**
   * Changes made to the `target_id`
   *
   * @see {@link https://discord.com/developers/docs/resources/audit-log#audit-log-change-object}
   */
  changes?: APIAuditLogChange[];
  /**
   * The user who made the changes
   *
   * This can be `null` in some cases (webhooks deleting themselves by using their own token, for example)
   */
  user_id: Snowflake | null;
  /**
   * ID of the entry
   */
  id: Snowflake;
  /**
   * Type of action that occurred
   *
   * @see {@link https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events}
   */
  action_type: AuditLogEvent;
  /**
   * Additional info for certain action types
   *
   * @see {@link https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-optional-audit-entry-info}
   */
  options?: APIAuditLogOptions;
  /**
   * The reason for the change (0-512 characters)
   */
  reason?: string;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events}
 */
declare enum AuditLogEvent {
  GuildUpdate = 1,
  ChannelCreate = 10,
  ChannelUpdate = 11,
  ChannelDelete = 12,
  ChannelOverwriteCreate = 13,
  ChannelOverwriteUpdate = 14,
  ChannelOverwriteDelete = 15,
  MemberKick = 20,
  MemberPrune = 21,
  MemberBanAdd = 22,
  MemberBanRemove = 23,
  MemberUpdate = 24,
  MemberRoleUpdate = 25,
  MemberMove = 26,
  MemberDisconnect = 27,
  BotAdd = 28,
  RoleCreate = 30,
  RoleUpdate = 31,
  RoleDelete = 32,
  InviteCreate = 40,
  InviteUpdate = 41,
  InviteDelete = 42,
  WebhookCreate = 50,
  WebhookUpdate = 51,
  WebhookDelete = 52,
  EmojiCreate = 60,
  EmojiUpdate = 61,
  EmojiDelete = 62,
  MessageDelete = 72,
  MessageBulkDelete = 73,
  MessagePin = 74,
  MessageUnpin = 75,
  IntegrationCreate = 80,
  IntegrationUpdate = 81,
  IntegrationDelete = 82,
  StageInstanceCreate = 83,
  StageInstanceUpdate = 84,
  StageInstanceDelete = 85,
  StickerCreate = 90,
  StickerUpdate = 91,
  StickerDelete = 92,
  GuildScheduledEventCreate = 100,
  GuildScheduledEventUpdate = 101,
  GuildScheduledEventDelete = 102,
  ThreadCreate = 110,
  ThreadUpdate = 111,
  ThreadDelete = 112,
  ApplicationCommandPermissionUpdate = 121,
  SoundboardSoundCreate = 130,
  SoundboardSoundUpdate = 131,
  SoundboardSoundDelete = 132,
  AutoModerationRuleCreate = 140,
  AutoModerationRuleUpdate = 141,
  AutoModerationRuleDelete = 142,
  AutoModerationBlockMessage = 143,
  AutoModerationFlagToChannel = 144,
  AutoModerationUserCommunicationDisabled = 145,
  AutoModerationQuarantineUser = 146,
  CreatorMonetizationRequestCreated = 150,
  CreatorMonetizationTermsAccepted = 151,
  OnboardingPromptCreate = 163,
  OnboardingPromptUpdate = 164,
  OnboardingPromptDelete = 165,
  OnboardingCreate = 166,
  OnboardingUpdate = 167,
  HomeSettingsCreate = 190,
  HomeSettingsUpdate = 191
}
/**
 * @see {@link https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-optional-audit-entry-info}
 */
interface APIAuditLogOptions {
  /**
   * Name of the Auto Moderation rule that was triggered
   *
   * Present from:
   * - AUTO_MODERATION_BLOCK_MESSAGE
   * - AUTO_MODERATION_FLAG_TO_CHANNEL
   * - AUTO_MODERATION_USER_COMMUNICATION_DISABLED
   * - AUTO_MODERATION_QUARANTINE_USER
   */
  auto_moderation_rule_name?: string;
  /**
   * Trigger type of the Auto Moderation rule that was triggered
   *
   * Present from:
   * - AUTO_MODERATION_BLOCK_MESSAGE
   * - AUTO_MODERATION_FLAG_TO_CHANNEL
   * - AUTO_MODERATION_USER_COMMUNICATION_DISABLED
   * - AUTO_MODERATION_QUARANTINE_USER
   */
  auto_moderation_rule_trigger_type?: AuditLogRuleTriggerType;
  /**
   * Number of days after which inactive members were kicked
   *
   * Present from:
   * - MEMBER_PRUNE
   */
  delete_member_days?: string;
  /**
   * Number of members removed by the prune
   *
   * Present from:
   * - MEMBER_PRUNE
   */
  members_removed?: string;
  /**
   * Channel in which the entities were targeted
   *
   * Present from:
   * - MEMBER_MOVE
   * - MESSAGE_PIN
   * - MESSAGE_UNPIN
   * - MESSAGE_DELETE
   * - STAGE_INSTANCE_CREATE
   * - STAGE_INSTANCE_UPDATE
   * - STAGE_INSTANCE_DELETE
   * - AUTO_MODERATION_BLOCK_MESSAGE
   * - AUTO_MODERATION_FLAG_TO_CHANNEL
   * - AUTO_MODERATION_USER_COMMUNICATION_DISABLED
   * - AUTO_MODERATION_QUARANTINE_USER
   */
  channel_id?: Snowflake;
  /**
   * ID of the message that was targeted
   *
   * Present from:
   * - MESSAGE_PIN
   * - MESSAGE_UNPIN
   */
  message_id?: Snowflake;
  /**
   * Number of entities that were targeted
   *
   * Present from:
   * - MESSAGE_DELETE
   * - MESSAGE_BULK_DELETE
   * - MEMBER_DISCONNECT
   * - MEMBER_MOVE
   */
  count?: string;
  /**
   * ID of the overwritten entity
   *
   * Present from:
   * - CHANNEL_OVERWRITE_CREATE
   * - CHANNEL_OVERWRITE_UPDATE
   * - CHANNEL_OVERWRITE_DELETE
   */
  id?: Snowflake;
  /**
   * Type of overwritten entity - "0" for "role" or "1" for "member"
   *
   * Present from:
   * - CHANNEL_OVERWRITE_CREATE
   * - CHANNEL_OVERWRITE_UPDATE
   * - CHANNEL_OVERWRITE_DELETE
   *
   * {@link AuditLogOptionsType}
   */
  type?: AuditLogOptionsType;
  /**
   * Name of the role
   *
   * Present from:
   * - CHANNEL_OVERWRITE_CREATE
   * - CHANNEL_OVERWRITE_UPDATE
   * - CHANNEL_OVERWRITE_DELETE
   *
   * **Present only if the {@link APIAuditLogOptions."type" | entry type} is "0"**
   */
  role_name?: string;
  /**
   * Type of integration which performed the action
   *
   * Present from:
   * - MEMBER_KICK
   * - MEMBER_ROLE_UPDATE
   */
  integration_type?: APIGuildIntegrationType;
  /**
   * ID of the app whose permissions were targeted
   *
   * Present from:
   * - APPLICATION_COMMAND_PERMISSION_UPDATE
   */
  application_id?: Snowflake;
}
declare enum AuditLogOptionsType {
  Role = "0",
  Member = "1"
}
type AuditLogRuleTriggerType = `${AutoModerationRuleTriggerType}`;
/**
 * @see {@link https://discord.com/developers/docs/resources/audit-log#audit-log-change-object-audit-log-change-structure}
 */
type APIAuditLogChange = APIAuditLogChangeKey$Add | APIAuditLogChangeKey$Remove | APIAuditLogChangeKeyActions | APIAuditLogChangeKeyAFKChannelId | APIAuditLogChangeKeyAFKTimeout | APIAuditLogChangeKeyAllow | APIAuditLogChangeKeyApplicationId | APIAuditLogChangeKeyArchived | APIAuditLogChangeKeyAsset | APIAuditLogChangeKeyAutoArchiveDuration | APIAuditLogChangeKeyAvailable | APIAuditLogChangeKeyAvailableTags | APIAuditLogChangeKeyAvatarHash | APIAuditLogChangeKeyBannerHash | APIAuditLogChangeKeyBitrate | APIAuditLogChangeKeyChannelId | APIAuditLogChangeKeyCode | APIAuditLogChangeKeyColor | APIAuditLogChangeKeyCommunicationDisabledUntil | APIAuditLogChangeKeyDeaf | APIAuditLogChangeKeyDefaultAutoArchiveDuration | APIAuditLogChangeKeyDefaultMessageNotifications | APIAuditLogChangeKeyDefaultReactionEmoji | APIAuditLogChangeKeyDefaultThreadRateLimitPerUser | APIAuditLogChangeKeyDeny | APIAuditLogChangeKeyDescription | APIAuditLogChangeKeyDiscoverySplashHash | APIAuditLogChangeKeyEmojiId | APIAuditLogChangeKeyEmojiName | APIAuditLogChangeKeyEnabled | APIAuditLogChangeKeyEnableEmoticons | APIAuditLogChangeKeyEntityType | APIAuditLogChangeKeyEventType | APIAuditLogChangeKeyExemptChannels | APIAuditLogChangeKeyExemptRoles | APIAuditLogChangeKeyExpireBehavior | APIAuditLogChangeKeyExpireGracePeriod | APIAuditLogChangeKeyExplicitContentFilter | APIAuditLogChangeKeyFlags | APIAuditLogChangeKeyFormatType | APIAuditLogChangeKeyGuildId | APIAuditLogChangeKeyHoist | APIAuditLogChangeKeyIconHash | APIAuditLogChangeKeyId | APIAuditLogChangeKeyImageHash | APIAuditLogChangeKeyInviterId | APIAuditLogChangeKeyLocation | APIAuditLogChangeKeyLocked | APIAuditLogChangeKeyMaxAge | APIAuditLogChangeKeyMaxUses | APIAuditLogChangeKeyMentionable | APIAuditLogChangeKeyMFALevel | APIAuditLogChangeKeyMute | APIAuditLogChangeKeyName | APIAuditLogChangeKeyNick | APIAuditLogChangeKeyNSFW | APIAuditLogChangeKeyOwnerId | APIAuditLogChangeKeyPermissionOverwrites | APIAuditLogChangeKeyPermissions | APIAuditLogChangeKeyPosition | APIAuditLogChangeKeyPreferredLocale | APIAuditLogChangeKeyPremiumProgressBarEnabled | APIAuditLogChangeKeyPrivacyLevel | APIAuditLogChangeKeyPruneDeleteDays | APIAuditLogChangeKeyPublicUpdatesChannelId | APIAuditLogChangeKeyRateLimitPerUser | APIAuditLogChangeKeyRecurrenceRule | APIAuditLogChangeKeyRegion | APIAuditLogChangeKeyRTCRegion | APIAuditLogChangeKeyRulesChannelId | APIAuditLogChangeKeySafetyAlertsChannelId | APIAuditLogChangeKeySoundId | APIAuditLogChangeKeySplashHash | APIAuditLogChangeKeyStatus | APIAuditLogChangeKeySystemChannelFlags | APIAuditLogChangeKeySystemChannelId | APIAuditLogChangeKeyTags | APIAuditLogChangeKeyTemporary | APIAuditLogChangeKeyTopic | APIAuditLogChangeKeyTriggerMetadata | APIAuditLogChangeKeyTriggerType | APIAuditLogChangeKeyType | APIAuditLogChangeKeyUserId | APIAuditLogChangeKeyUserLimit | APIAuditLogChangeKeyUses | APIAuditLogChangeKeyVanityURLCode | APIAuditLogChangeKeyVerificationLevel | APIAuditLogChangeKeyVideoQualityMode | APIAuditLogChangeKeyVolume | APIAuditLogChangeKeyWidgetChannelId | APIAuditLogChangeKeyWidgetEnabled;
/**
 * Returned when an entity's name is changed
 */
type APIAuditLogChangeKeyName = APIAuditLogChangeData<'name', string>;
/**
 * Returned when a guild's or sticker's or guild scheduled event's description is changed
 */
type APIAuditLogChangeKeyDescription = APIAuditLogChangeData<'description', string>;
/**
 * Returned when a guild's icon is changed
 */
type APIAuditLogChangeKeyIconHash = APIAuditLogChangeData<'icon_hash', string>;
/**
 * Returned when a guild's scheduled event's cover image is changed
 */
type APIAuditLogChangeKeyImageHash = APIAuditLogChangeData<'image_hash', string>;
/**
 * Returned when a guild's splash is changed
 */
type APIAuditLogChangeKeySplashHash = APIAuditLogChangeData<'splash_hash', string>;
/**
 * Returned when a guild's discovery splash is changed
 */
type APIAuditLogChangeKeyDiscoverySplashHash = APIAuditLogChangeData<'discovery_splash_hash', string>;
/**
 * Returned when a guild's banner hash is changed
 */
type APIAuditLogChangeKeyBannerHash = APIAuditLogChangeData<'banner_hash', string>;
/**
 * Returned when a guild's owner_id is changed
 */
type APIAuditLogChangeKeyOwnerId = APIAuditLogChangeData<'owner_id', Snowflake>;
/**
 * Returned when a guild's region is changed
 */
type APIAuditLogChangeKeyRegion = APIAuditLogChangeData<'region', string>;
/**
 * Returned when a channel's rtc_region is changed
 */
type APIAuditLogChangeKeyRTCRegion = APIAuditLogChangeData<'rtc_region', string>;
/**
 * Returned when a guild's preferred_locale is changed
 */
type APIAuditLogChangeKeyPreferredLocale = APIAuditLogChangeData<'preferred_locale', string>;
/**
 * Returned when a guild's afk_channel_id is changed
 */
type APIAuditLogChangeKeyAFKChannelId = APIAuditLogChangeData<'afk_channel_id', Snowflake>;
/**
 * Returned when a guild's afk_timeout is changed
 */
type APIAuditLogChangeKeyAFKTimeout = APIAuditLogChangeData<'afk_timeout', number>;
/**
 * Returned when a guild's rules_channel_id is changed
 */
type APIAuditLogChangeKeyRulesChannelId = APIAuditLogChangeData<'rules_channel_id', string>;
/**
 * Returned when a guild's public_updates_channel_id is changed
 */
type APIAuditLogChangeKeyPublicUpdatesChannelId = APIAuditLogChangeData<'public_updates_channel_id', string>;
/**
 * Returned when a guild's safety_alerts_channel_id is changed
 */
type APIAuditLogChangeKeySafetyAlertsChannelId = APIAuditLogChangeData<'safety_alerts_channel_id', string>;
/**
 * Returned when a guild's mfa_level is changed
 */
type APIAuditLogChangeKeyMFALevel = APIAuditLogChangeData<'mfa_level', GuildMFALevel>;
/**
 * Returned when a guild's verification_level is changed
 */
type APIAuditLogChangeKeyVerificationLevel = APIAuditLogChangeData<'verification_level', GuildVerificationLevel>;
/**
 * Returned when a channel's video_quality_mode is changed
 */
type APIAuditLogChangeKeyVideoQualityMode = APIAuditLogChangeData<'video_quality_mode', VideoQualityMode>;
/**
 * Returned when a guild's explicit_content_filter is changed
 */
type APIAuditLogChangeKeyExplicitContentFilter = APIAuditLogChangeData<'explicit_content_filter', GuildExplicitContentFilter>;
/**
 * Returned when a guild's default_message_notifications is changed
 */
type APIAuditLogChangeKeyDefaultMessageNotifications = APIAuditLogChangeData<'default_message_notifications', GuildDefaultMessageNotifications>;
/**
 * Returned when a guild's vanity_url_code is changed
 */
type APIAuditLogChangeKeyVanityURLCode = APIAuditLogChangeData<'vanity_url_code', string>;
/**
 * Returned when a guild's boost progress bar is enabled
 */
type APIAuditLogChangeKeyPremiumProgressBarEnabled = APIAuditLogChangeData<'premium_progress_bar_enabled', boolean>;
/**
 * Returned when new role(s) are added
 */
type APIAuditLogChangeKey$Add = APIAuditLogChangeData<'$add', Pick<APIRole, 'id' | 'name'>[]>;
/**
 * Returned when role(s) are removed
 */
type APIAuditLogChangeKey$Remove = APIAuditLogChangeData<'$remove', Pick<APIRole, 'id' | 'name'>[]>;
/**
 * Returned when there is a change in number of days after which inactive and role-unassigned members are kicked
 */
type APIAuditLogChangeKeyPruneDeleteDays = APIAuditLogChangeData<'prune_delete_days', number>;
/**
 * Returned when a guild's widget is enabled
 */
type APIAuditLogChangeKeyWidgetEnabled = APIAuditLogChangeData<'widget_enabled', boolean>;
/**
 * Returned when a guild's widget_channel_id is changed
 */
type APIAuditLogChangeKeyWidgetChannelId = APIAuditLogChangeData<'widget_channel_id', Snowflake>;
/**
 * Returned when a guild's system_channel_flags is changed
 */
type APIAuditLogChangeKeySystemChannelFlags = APIAuditLogChangeData<'system_channel_flags', GuildSystemChannelFlags>;
/**
 * Returned when a guild's system_channel_id is changed
 */
type APIAuditLogChangeKeySystemChannelId = APIAuditLogChangeData<'system_channel_id', Snowflake>;
/**
 * Returned when a channel's position is changed
 */
type APIAuditLogChangeKeyPosition = APIAuditLogChangeData<'position', number>;
/**
 * Returned when a channel's topic is changed
 */
type APIAuditLogChangeKeyTopic = APIAuditLogChangeData<'topic', string>;
/**
 * Returned when a voice channel's bitrate is changed
 */
type APIAuditLogChangeKeyBitrate = APIAuditLogChangeData<'bitrate', number>;
/**
 * Returned when a channel's permission overwrites is changed
 */
type APIAuditLogChangeKeyPermissionOverwrites = APIAuditLogChangeData<'permission_overwrites', APIOverwrite[]>;
/**
 * Returned when a channel's NSFW restriction is changed
 */
type APIAuditLogChangeKeyNSFW = APIAuditLogChangeData<'nsfw', boolean>;
/**
 * The application ID of the added or removed Webhook or Bot
 */
type APIAuditLogChangeKeyApplicationId = APIAuditLogChangeData<'application_id', Snowflake>;
/**
 * Returned when a channel's amount of seconds a user has to wait before sending another message
 * is changed
 */
type APIAuditLogChangeKeyRateLimitPerUser = APIAuditLogChangeData<'rate_limit_per_user', number>;
/**
 * Returned when a guild scheduled event's recurrence_rule is changed
 */
type APIAuditLogChangeKeyRecurrenceRule = APIAuditLogChangeData<'recurrence_rule', APIGuildScheduledEventRecurrenceRule>;
/**
 * Returned when a permission bitfield is changed
 */
type APIAuditLogChangeKeyPermissions = APIAuditLogChangeData<'permissions', string>;
/**
 * Returned when a role's color is changed
 */
type APIAuditLogChangeKeyColor = APIAuditLogChangeData<'color', number>;
/**
 * Returned when a role's hoist status is changed
 */
type APIAuditLogChangeKeyHoist = APIAuditLogChangeData<'hoist', boolean>;
/**
 * Returned when a role's mentionable status is changed
 */
type APIAuditLogChangeKeyMentionable = APIAuditLogChangeData<'mentionable', boolean>;
/**
 * Returned when an overwrite's allowed permissions bitfield is changed
 */
type APIAuditLogChangeKeyAllow = APIAuditLogChangeData<'allow', string>;
/**
 * Returned when an overwrite's denied permissions bitfield is changed
 */
type APIAuditLogChangeKeyDeny = APIAuditLogChangeData<'deny', string>;
/**
 * Returned when an invite's code is changed
 */
type APIAuditLogChangeKeyCode = APIAuditLogChangeData<'code', string>;
/**
 * Returned when an invite's or guild scheduled event's channel_id is changed
 */
type APIAuditLogChangeKeyChannelId = APIAuditLogChangeData<'channel_id', Snowflake>;
/**
 * Returned when an invite's inviter_id is changed
 */
type APIAuditLogChangeKeyInviterId = APIAuditLogChangeData<'inviter_id', Snowflake>;
/**
 * Returned when an invite's max_uses is changed
 */
type APIAuditLogChangeKeyMaxUses = APIAuditLogChangeData<'max_uses', number>;
/**
 * Returned when an invite's uses is changed
 */
type APIAuditLogChangeKeyUses = APIAuditLogChangeData<'uses', number>;
/**
 * Returned when an invite's max_age is changed
 */
type APIAuditLogChangeKeyMaxAge = APIAuditLogChangeData<'max_age', number>;
/**
 * Returned when an invite's temporary status is changed
 */
type APIAuditLogChangeKeyTemporary = APIAuditLogChangeData<'temporary', boolean>;
/**
 * Returned when a user's deaf status is changed
 */
type APIAuditLogChangeKeyDeaf = APIAuditLogChangeData<'deaf', boolean>;
/**
 * Returned when a user's mute status is changed
 */
type APIAuditLogChangeKeyMute = APIAuditLogChangeData<'mute', boolean>;
/**
 * Returned when a user's nick is changed
 */
type APIAuditLogChangeKeyNick = APIAuditLogChangeData<'nick', string>;
/**
 * Returned when a user's avatar_hash is changed
 */
type APIAuditLogChangeKeyAvatarHash = APIAuditLogChangeData<'avatar_hash', string>;
/**
 * The ID of the changed entity - sometimes used in conjunction with other keys
 */
type APIAuditLogChangeKeyId = APIAuditLogChangeData<'id', Snowflake>;
/**
 * The type of entity created
 */
type APIAuditLogChangeKeyType = APIAuditLogChangeData<'type', number | string>;
/**
 * Returned when an integration's enable_emoticons is changed
 */
type APIAuditLogChangeKeyEnableEmoticons = APIAuditLogChangeData<'enable_emoticons', boolean>;
/**
 * Returned when an integration's expire_behavior is changed
 */
type APIAuditLogChangeKeyExpireBehavior = APIAuditLogChangeData<'expire_behavior', IntegrationExpireBehavior>;
/**
 * Returned when an integration's expire_grace_period is changed
 */
type APIAuditLogChangeKeyExpireGracePeriod = APIAuditLogChangeData<'expire_grace_period', number>;
/**
 * Returned when a voice channel's user_limit is changed
 */
type APIAuditLogChangeKeyUserLimit = APIAuditLogChangeData<'user_limit', number>;
/**
 * Returned when privacy level of a stage instance or guild scheduled event is changed
 */
type APIAuditLogChangeKeyPrivacyLevel = APIAuditLogChangeData<'privacy_level', StageInstancePrivacyLevel>;
/**
 * Returned when a sticker's related emoji is changed
 */
type APIAuditLogChangeKeyTags = APIAuditLogChangeData<'tags', string>;
/**
 * Returned when a sticker's format_type is changed
 */
type APIAuditLogChangeKeyFormatType = APIAuditLogChangeData<'format_type', StickerFormatType>;
/**
 * Empty string
 */
type APIAuditLogChangeKeyAsset = APIAuditLogChangeData<'asset', ''>;
/**
 * Returned when a sticker's availability is changed
 */
type APIAuditLogChangeKeyAvailable = APIAuditLogChangeData<'available', boolean>;
/**
 * Returned when a sticker's guild_id is changed
 */
type APIAuditLogChangeKeyGuildId = APIAuditLogChangeData<'guild_id', Snowflake>;
/**
 * Returned when a thread's archive status is changed
 */
type APIAuditLogChangeKeyArchived = APIAuditLogChangeData<'archived', boolean>;
/**
 * Returned when a thread's lock status is changed
 */
type APIAuditLogChangeKeyLocked = APIAuditLogChangeData<'locked', boolean>;
/**
 * Returned when a thread's auto archive duration is changed
 */
type APIAuditLogChangeKeyAutoArchiveDuration = APIAuditLogChangeData<'auto_archive_duration', number>;
/**
 * Returned when a channel's default auto archive duration for newly created threads is changed
 */
type APIAuditLogChangeKeyDefaultAutoArchiveDuration = APIAuditLogChangeData<'default_auto_archive_duration', number>;
/**
 * Returned when entity type of a guild scheduled event is changed
 */
type APIAuditLogChangeKeyEntityType = APIAuditLogChangeData<'entity_type', GuildScheduledEventEntityType>;
/**
 * Returned when status of a guild scheduled event is changed
 */
type APIAuditLogChangeKeyStatus = APIAuditLogChangeData<'status', GuildScheduledEventStatus>;
/**
 * Returned when location of a guild scheduled event is changed
 */
type APIAuditLogChangeKeyLocation = APIAuditLogChangeData<'location', string>;
/**
 * Returned when a user's timeout is changed
 */
type APIAuditLogChangeKeyCommunicationDisabledUntil = APIAuditLogChangeData<'communication_disabled_until', string>;
/**
 * Returned when an auto moderation rule's trigger type is changed (only in rule creation or deletion)
 */
type APIAuditLogChangeKeyTriggerType = APIAuditLogChangeData<'trigger_type', AutoModerationRuleTriggerType>;
/**
 * Returned when an auto moderation rule's event type is changed
 */
type APIAuditLogChangeKeyEventType = APIAuditLogChangeData<'event_type', AutoModerationRuleEventType>;
/**
 * Returned when an auto moderation rule's trigger metadata is changed
 */
type APIAuditLogChangeKeyTriggerMetadata = APIAuditLogChangeData<'trigger_metadata', APIAutoModerationRuleTriggerMetadata>;
/**
 * Returned when an auto moderation rule's actions is changed
 */
type APIAuditLogChangeKeyActions = APIAuditLogChangeData<'actions', APIAutoModerationAction[]>;
/**
 * Returned when an auto moderation rule's enabled status is changed
 */
type APIAuditLogChangeKeyEnabled = APIAuditLogChangeData<'enabled', boolean>;
/**
 * Returned when an auto moderation rule's exempt roles is changed
 */
type APIAuditLogChangeKeyExemptRoles = APIAuditLogChangeData<'exempt_roles', Snowflake[]>;
/**
 * Returned when an auto moderation rule's exempt channels is changed
 */
type APIAuditLogChangeKeyExemptChannels = APIAuditLogChangeData<'exempt_channels', Snowflake[]>;
/**
 * Returned when a guild forum's available tags gets changed
 */
type APIAuditLogChangeKeyAvailableTags = APIAuditLogChangeData<'available_tags', APIGuildForumTag[]>;
/**
 * Returned when a guild forum's default reaction emoji gets changed
 */
type APIAuditLogChangeKeyDefaultReactionEmoji = APIAuditLogChangeData<'default_reaction_emoji', APIGuildForumDefaultReactionEmoji>;
/**
 * Returned when a channel flag gets changed
 */
type APIAuditLogChangeKeyFlags = APIAuditLogChangeData<'flags', number>;
/**
 * Returned when a thread's amount of seconds a user has to wait before creating another thread
 * gets changed
 */
type APIAuditLogChangeKeyDefaultThreadRateLimitPerUser = APIAuditLogChangeData<'default_thread_rate_limit_per_user', number>;
/**
 * Returned when a soundboard is create or deleted
 */
type APIAuditLogChangeKeySoundId = APIAuditLogChangeData<'sound_id', Snowflake>;
/**
 * Returned when a soundboard's volume is changed
 */
type APIAuditLogChangeKeyVolume = APIAuditLogChangeData<'volume', number>;
/**
 * Returned when a soundboard's custom emoji is changed
 */
type APIAuditLogChangeKeyEmojiId = APIAuditLogChangeData<'emoji_id', Snowflake>;
/**
 * Returned when a soundboard's unicode emoji is changed
 */
type APIAuditLogChangeKeyEmojiName = APIAuditLogChangeData<'emoji_name', string>;
/**
 * Returned when a sounboard is created
 */
type APIAuditLogChangeKeyUserId = APIAuditLogChangeData<'user_id', Snowflake>;
interface APIAuditLogChangeData<K extends string, D> {
  key: K;
  /**
   * The new value
   *
   * If `new_value` is not present in the change object, while `old_value` is,
   * that means the property that was changed has been reset, or set to `null`
   */
  new_value?: D;
  old_value?: D;
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/invite.d.ts
/**
 * @see {@link https://discord.com/developers/docs/resources/invite#invite-object-invite-target-types}
 */
declare enum InviteTargetType {
  Stream = 1,
  EmbeddedApplication = 2
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/soundboard.d.ts
/**
 * @see {@link https://discord.com/developers/docs/resources/soundboard#soundboard-sound-object}
 */
interface APISoundboardSound {
  /**
   * The name of this sound
   */
  name: string;
  /**
   * The id of this sound
   */
  sound_id: Snowflake;
  /**
   * The volume of this sound, from 0 to 1
   */
  volume: number;
  /**
   * The id of this sound's custom emoji
   */
  emoji_id: Snowflake | null;
  /**
   * The unicode character of this sound's standard emoji
   */
  emoji_name: string | null;
  /**
   * The id of the guild that this sound is in
   */
  guild_id?: Snowflake;
  /**
   * Whether this sound can be used (for guild sounds), may be false due to loss of Server Boosts
   */
  available: boolean;
  /**
   * The user who created this sound
   */
  user?: APIUser;
}
//#endregion
//#region node_modules/discord-api-types/rest/v10/channel.d.ts
/**
 * @see {@link https://discord.com/developers/docs/resources/channel#get-reactions-reaction-types}
 */
declare enum ReactionType {
  Normal = 0,
  Burst = 1,
  /**
   * @deprecated Use {@link ReactionType.Burst} instead
   */
  Super = 1
}
//#endregion
//#region node_modules/discord-api-types/rest/v10/interactions.d.ts
interface RESTPostAPIBaseApplicationCommandsJSONBody extends _AddUndefinedToPossiblyUndefinedPropertiesOfInterface<Omit<APIApplicationCommand, 'application_id' | 'contexts' | 'default_member_permissions' | 'description_localized' | 'description' | 'guild_id' | 'id' | 'integration_types' | 'name_localized' | 'type' | 'version'>>, _AddUndefinedToPossiblyUndefinedPropertiesOfInterface<Partial<_NonNullableFields<Pick<APIApplicationCommand, 'contexts'>> & Pick<APIApplicationCommand, 'default_member_permissions' | 'integration_types'>>> {}
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#create-global-application-command}
 */
interface RESTPostAPIChatInputApplicationCommandsJSONBody extends RESTPostAPIBaseApplicationCommandsJSONBody {
  type?: ApplicationCommandType.ChatInput | undefined;
  description: string;
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#create-global-application-command}
 */
interface RESTPostAPIContextMenuApplicationCommandsJSONBody extends RESTPostAPIBaseApplicationCommandsJSONBody {
  type: ApplicationCommandType.Message | ApplicationCommandType.User;
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#create-global-application-command}
 */
interface RESTPostAPIPrimaryEntryPointApplicationCommandJSONBody extends RESTPostAPIBaseApplicationCommandsJSONBody {
  type: ApplicationCommandType.PrimaryEntryPoint;
}
/**
 * @see {@link https://discord.com/developers/docs/interactions/application-commands#create-global-application-command}
 */
type RESTPostAPIApplicationCommandsJSONBody = RESTPostAPIChatInputApplicationCommandsJSONBody | RESTPostAPIContextMenuApplicationCommandsJSONBody | RESTPostAPIPrimaryEntryPointApplicationCommandJSONBody;
//#endregion
//#region node_modules/discord-api-types/gateway/v10.d.ts
/**
 * @see {@link https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-opcodes}
 */
declare enum GatewayOpcodes {
  /**
   * An event was dispatched
   */
  Dispatch = 0,
  /**
   * A bidirectional opcode to maintain an active gateway connection.
   * Fired periodically by the client, or fired by the gateway to request an immediate heartbeat from the client.
   */
  Heartbeat = 1,
  /**
   * Starts a new session during the initial handshake
   */
  Identify = 2,
  /**
   * Update the client's presence
   */
  PresenceUpdate = 3,
  /**
   * Used to join/leave or move between voice channels
   */
  VoiceStateUpdate = 4,
  /**
   * Resume a previous session that was disconnected
   */
  Resume = 6,
  /**
   * You should attempt to reconnect and resume immediately
   */
  Reconnect = 7,
  /**
   * Request information about offline guild members in a large guild
   */
  RequestGuildMembers = 8,
  /**
   * The session has been invalidated. You should reconnect and identify/resume accordingly
   */
  InvalidSession = 9,
  /**
   * Sent immediately after connecting, contains the `heartbeat_interval` to use
   */
  Hello = 10,
  /**
   * Sent in response to receiving a heartbeat to acknowledge that it has been received
   */
  HeartbeatAck = 11,
  /**
   * Request information about soundboard sounds in a set of guilds
   */
  RequestSoundboardSounds = 31
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#receive-events}
 */
declare enum GatewayDispatchEvents {
  ApplicationCommandPermissionsUpdate = "APPLICATION_COMMAND_PERMISSIONS_UPDATE",
  AutoModerationActionExecution = "AUTO_MODERATION_ACTION_EXECUTION",
  AutoModerationRuleCreate = "AUTO_MODERATION_RULE_CREATE",
  AutoModerationRuleDelete = "AUTO_MODERATION_RULE_DELETE",
  AutoModerationRuleUpdate = "AUTO_MODERATION_RULE_UPDATE",
  ChannelCreate = "CHANNEL_CREATE",
  ChannelDelete = "CHANNEL_DELETE",
  ChannelPinsUpdate = "CHANNEL_PINS_UPDATE",
  ChannelUpdate = "CHANNEL_UPDATE",
  EntitlementCreate = "ENTITLEMENT_CREATE",
  EntitlementDelete = "ENTITLEMENT_DELETE",
  EntitlementUpdate = "ENTITLEMENT_UPDATE",
  GuildAuditLogEntryCreate = "GUILD_AUDIT_LOG_ENTRY_CREATE",
  GuildBanAdd = "GUILD_BAN_ADD",
  GuildBanRemove = "GUILD_BAN_REMOVE",
  GuildCreate = "GUILD_CREATE",
  GuildDelete = "GUILD_DELETE",
  GuildEmojisUpdate = "GUILD_EMOJIS_UPDATE",
  GuildIntegrationsUpdate = "GUILD_INTEGRATIONS_UPDATE",
  GuildMemberAdd = "GUILD_MEMBER_ADD",
  GuildMemberRemove = "GUILD_MEMBER_REMOVE",
  GuildMembersChunk = "GUILD_MEMBERS_CHUNK",
  GuildMemberUpdate = "GUILD_MEMBER_UPDATE",
  GuildRoleCreate = "GUILD_ROLE_CREATE",
  GuildRoleDelete = "GUILD_ROLE_DELETE",
  GuildRoleUpdate = "GUILD_ROLE_UPDATE",
  GuildScheduledEventCreate = "GUILD_SCHEDULED_EVENT_CREATE",
  GuildScheduledEventDelete = "GUILD_SCHEDULED_EVENT_DELETE",
  GuildScheduledEventUpdate = "GUILD_SCHEDULED_EVENT_UPDATE",
  GuildScheduledEventUserAdd = "GUILD_SCHEDULED_EVENT_USER_ADD",
  GuildScheduledEventUserRemove = "GUILD_SCHEDULED_EVENT_USER_REMOVE",
  GuildSoundboardSoundCreate = "GUILD_SOUNDBOARD_SOUND_CREATE",
  GuildSoundboardSoundDelete = "GUILD_SOUNDBOARD_SOUND_DELETE",
  GuildSoundboardSoundsUpdate = "GUILD_SOUNDBOARD_SOUNDS_UPDATE",
  GuildSoundboardSoundUpdate = "GUILD_SOUNDBOARD_SOUND_UPDATE",
  SoundboardSounds = "SOUNDBOARD_SOUNDS",
  GuildStickersUpdate = "GUILD_STICKERS_UPDATE",
  GuildUpdate = "GUILD_UPDATE",
  IntegrationCreate = "INTEGRATION_CREATE",
  IntegrationDelete = "INTEGRATION_DELETE",
  IntegrationUpdate = "INTEGRATION_UPDATE",
  InteractionCreate = "INTERACTION_CREATE",
  InviteCreate = "INVITE_CREATE",
  InviteDelete = "INVITE_DELETE",
  MessageCreate = "MESSAGE_CREATE",
  MessageDelete = "MESSAGE_DELETE",
  MessageDeleteBulk = "MESSAGE_DELETE_BULK",
  MessagePollVoteAdd = "MESSAGE_POLL_VOTE_ADD",
  MessagePollVoteRemove = "MESSAGE_POLL_VOTE_REMOVE",
  MessageReactionAdd = "MESSAGE_REACTION_ADD",
  MessageReactionRemove = "MESSAGE_REACTION_REMOVE",
  MessageReactionRemoveAll = "MESSAGE_REACTION_REMOVE_ALL",
  MessageReactionRemoveEmoji = "MESSAGE_REACTION_REMOVE_EMOJI",
  MessageUpdate = "MESSAGE_UPDATE",
  PresenceUpdate = "PRESENCE_UPDATE",
  RateLimited = "RATE_LIMITED",
  Ready = "READY",
  Resumed = "RESUMED",
  StageInstanceCreate = "STAGE_INSTANCE_CREATE",
  StageInstanceDelete = "STAGE_INSTANCE_DELETE",
  StageInstanceUpdate = "STAGE_INSTANCE_UPDATE",
  SubscriptionCreate = "SUBSCRIPTION_CREATE",
  SubscriptionDelete = "SUBSCRIPTION_DELETE",
  SubscriptionUpdate = "SUBSCRIPTION_UPDATE",
  ThreadCreate = "THREAD_CREATE",
  ThreadDelete = "THREAD_DELETE",
  ThreadListSync = "THREAD_LIST_SYNC",
  ThreadMembersUpdate = "THREAD_MEMBERS_UPDATE",
  ThreadMemberUpdate = "THREAD_MEMBER_UPDATE",
  ThreadUpdate = "THREAD_UPDATE",
  TypingStart = "TYPING_START",
  UserUpdate = "USER_UPDATE",
  VoiceChannelEffectSend = "VOICE_CHANNEL_EFFECT_SEND",
  VoiceServerUpdate = "VOICE_SERVER_UPDATE",
  VoiceStateUpdate = "VOICE_STATE_UPDATE",
  WebhooksUpdate = "WEBHOOKS_UPDATE"
}
type GatewaySendPayload = GatewayHeartbeat | GatewayIdentify | GatewayRequestGuildMembers | GatewayRequestSoundboardSounds | GatewayResume | GatewayUpdatePresence | GatewayVoiceStateUpdate;
type GatewayReceivePayload = GatewayDispatchPayload | GatewayHeartbeatAck | GatewayHeartbeatRequest | GatewayHello | GatewayInvalidSession | GatewayReconnect;
type GatewayDispatchPayload = GatewayApplicationCommandPermissionsUpdateDispatch | GatewayAutoModerationActionExecutionDispatch | GatewayAutoModerationRuleCreateDispatch | GatewayAutoModerationRuleDeleteDispatch | GatewayAutoModerationRuleUpdateDispatch | GatewayChannelCreateDispatch | GatewayChannelDeleteDispatch | GatewayChannelPinsUpdateDispatch | GatewayChannelUpdateDispatch | GatewayEntitlementCreateDispatch | GatewayEntitlementDeleteDispatch | GatewayEntitlementUpdateDispatch | GatewayGuildAuditLogEntryCreateDispatch | GatewayGuildBanAddDispatch | GatewayGuildBanRemoveDispatch | GatewayGuildCreateDispatch | GatewayGuildDeleteDispatch | GatewayGuildEmojisUpdateDispatch | GatewayGuildIntegrationsUpdateDispatch | GatewayGuildMemberAddDispatch | GatewayGuildMemberRemoveDispatch | GatewayGuildMembersChunkDispatch | GatewayGuildMemberUpdateDispatch | GatewayGuildModifyDispatch | GatewayGuildRoleCreateDispatch | GatewayGuildRoleDeleteDispatch | GatewayGuildRoleUpdateDispatch | GatewayGuildScheduledEventCreateDispatch | GatewayGuildScheduledEventDeleteDispatch | GatewayGuildScheduledEventUpdateDispatch | GatewayGuildScheduledEventUserAddDispatch | GatewayGuildScheduledEventUserRemoveDispatch | GatewayGuildSoundboardSoundCreateDispatch | GatewayGuildSoundboardSoundDeleteDispatch | GatewayGuildSoundboardSoundsUpdateDispatch | GatewayGuildSoundboardSoundUpdateDispatch | GatewayGuildStickersUpdateDispatch | GatewayIntegrationCreateDispatch | GatewayIntegrationDeleteDispatch | GatewayIntegrationUpdateDispatch | GatewayInteractionCreateDispatch | GatewayInviteCreateDispatch | GatewayInviteDeleteDispatch | GatewayMessageCreateDispatch | GatewayMessageDeleteBulkDispatch | GatewayMessageDeleteDispatch | GatewayMessagePollVoteAddDispatch | GatewayMessagePollVoteRemoveDispatch | GatewayMessageReactionAddDispatch | GatewayMessageReactionRemoveAllDispatch | GatewayMessageReactionRemoveDispatch | GatewayMessageReactionRemoveEmojiDispatch | GatewayMessageUpdateDispatch | GatewayPresenceUpdateDispatch | GatewayRateLimitedDispatch | GatewayReadyDispatch | GatewayResumedDispatch | GatewaySoundboardSoundsDispatch | GatewayStageInstanceCreateDispatch | GatewayStageInstanceDeleteDispatch | GatewayStageInstanceUpdateDispatch | GatewaySubscriptionCreateDispatch | GatewaySubscriptionDeleteDispatch | GatewaySubscriptionUpdateDispatch | GatewayThreadCreateDispatch | GatewayThreadDeleteDispatch | GatewayThreadListSyncDispatch | GatewayThreadMembersUpdateDispatch | GatewayThreadMemberUpdateDispatch | GatewayThreadUpdateDispatch | GatewayTypingStartDispatch | GatewayUserUpdateDispatch | GatewayVoiceChannelEffectSendDispatch | GatewayVoiceServerUpdateDispatch | GatewayVoiceStateUpdateDispatch | GatewayWebhooksUpdateDispatch;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#hello}
 */
interface GatewayHello extends _NonDispatchPayload {
  op: GatewayOpcodes.Hello;
  d: GatewayHelloData;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#hello}
 */
interface GatewayHelloData {
  /**
   * The interval (in milliseconds) the client should heartbeat with
   */
  heartbeat_interval: number;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway#sending-heartbeats}
 */
interface GatewayHeartbeatRequest extends _NonDispatchPayload {
  op: GatewayOpcodes.Heartbeat;
  d: never;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#heartbeat}
 */
interface GatewayHeartbeatAck extends _NonDispatchPayload {
  op: GatewayOpcodes.HeartbeatAck;
  d: never;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#invalid-session}
 */
interface GatewayInvalidSession extends _NonDispatchPayload {
  op: GatewayOpcodes.InvalidSession;
  d: GatewayInvalidSessionData;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#invalid-session}
 */
type GatewayInvalidSessionData = boolean;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#reconnect}
 */
interface GatewayReconnect extends _NonDispatchPayload {
  op: GatewayOpcodes.Reconnect;
  d: never;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#ready}
 */
type GatewayReadyDispatch = _DataPayload<GatewayDispatchEvents.Ready, GatewayReadyDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#ready}
 */
interface GatewayReadyDispatchData {
  /**
   * Gateway version
   *
   * @see {@link https://discord.com/developers/docs/reference#api-versioning}
   */
  v: number;
  /**
   * Information about the user including email
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  user: APIUser;
  /**
   * The guilds the user is in
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#unavailable-guild-object}
   */
  guilds: APIUnavailableGuild[];
  /**
   * Used for resuming connections
   */
  session_id: string;
  /**
   * Gateway url for resuming connections
   */
  resume_gateway_url: string;
  /**
   * The shard information associated with this session, if sent when identifying
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway#sharding}
   */
  shard?: [shard_id: number, shard_count: number];
  /**
   * Contains `id` and `flags`
   *
   * @see {@link https://discord.com/developers/docs/resources/application#application-object}
   */
  application: Pick<APIApplication, 'flags' | 'id'>;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#resumed}
 */
type GatewayResumedDispatch = _DataPayload<GatewayDispatchEvents.Resumed, never>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#auto-moderation-rule-create}
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#auto-moderation-rule-update}
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#auto-moderation-rule-delete}
 */
type GatewayAutoModerationRuleModifyDispatchData = APIAutoModerationRule;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#auto-moderation-rule-create}
 */
type GatewayAutoModerationRuleCreateDispatch = _DataPayload<GatewayDispatchEvents.AutoModerationRuleCreate, GatewayAutoModerationRuleCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#auto-moderation-rule-create}
 */
type GatewayAutoModerationRuleCreateDispatchData = GatewayAutoModerationRuleModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#auto-moderation-rule-update}
 */
type GatewayAutoModerationRuleUpdateDispatch = _DataPayload<GatewayDispatchEvents.AutoModerationRuleUpdate, GatewayAutoModerationRuleUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#auto-moderation-rule-update}
 */
type GatewayAutoModerationRuleUpdateDispatchData = GatewayAutoModerationRuleModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#auto-moderation-rule-delete}
 */
type GatewayAutoModerationRuleDeleteDispatch = _DataPayload<GatewayDispatchEvents.AutoModerationRuleDelete, GatewayAutoModerationRuleDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#auto-moderation-rule-delete}
 */
type GatewayAutoModerationRuleDeleteDispatchData = GatewayAutoModerationRuleModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#auto-moderation-action-execution}
 */
type GatewayAutoModerationActionExecutionDispatch = _DataPayload<GatewayDispatchEvents.AutoModerationActionExecution, GatewayAutoModerationActionExecutionDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#auto-moderation-action-execution}
 */
interface GatewayAutoModerationActionExecutionDispatchData {
  /**
   * The id of the guild in which action was executed
   */
  guild_id: Snowflake;
  /**
   * The action which was executed
   */
  action: APIAutoModerationAction;
  /**
   * The id of the rule which action belongs to
   */
  rule_id: Snowflake;
  /**
   * The trigger type of rule which was triggered
   */
  rule_trigger_type: AutoModerationRuleTriggerType;
  /**
   * The id of the user which generated the content which triggered the rule
   */
  user_id: Snowflake;
  /**
   * The id of the channel in which user content was posted
   */
  channel_id?: Snowflake;
  /**
   * The id of any user message which content belongs to
   *
   * This field will not be present if message was blocked by AutoMod or content was not part of any message
   */
  message_id?: Snowflake;
  /**
   * The id of any system auto moderation messages posted as a result of this action
   *
   * This field will not be present if this event does not correspond to an action with type {@link AutoModerationActionType.SendAlertMessage}
   */
  alert_system_message_id?: Snowflake;
  /**
   * The user generated text content
   *
   * `MESSAGE_CONTENT` (`1 << 15`) gateway intent is required to receive non-empty values from this field
   */
  content: string;
  /**
   * The word or phrase configured in the rule that triggered the rule
   */
  matched_keyword: string | null;
  /**
   * The substring in content that triggered the rule
   *
   * `MESSAGE_CONTENT` (`1 << 15`) gateway intent is required to receive non-empty values from this field
   */
  matched_content: string | null;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#application-command-permissions-update}
 */
type GatewayApplicationCommandPermissionsUpdateDispatch = _DataPayload<GatewayDispatchEvents.ApplicationCommandPermissionsUpdate, GatewayApplicationCommandPermissionsUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#application-command-permissions-update}
 */
interface GatewayApplicationCommandPermissionsUpdateDispatchData {
  /**
   * ID of the command or the application ID
   */
  id: Snowflake;
  /**
   * ID of the application the command belongs to
   */
  application_id: Snowflake;
  /**
   * ID of the guild
   */
  guild_id: Snowflake;
  /**
   * Permissions for the command in the guild, max of 100
   */
  permissions: APIApplicationCommandPermission[];
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#subscription-create}
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#subscription-update}
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#subscription-delete}
 */
type GatewaySubscriptionModifyDispatchData = APISubscription;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#subscription-create}
 */
type GatewaySubscriptionCreateDispatch = _DataPayload<GatewayDispatchEvents.SubscriptionCreate, GatewaySubscriptionCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#subscription-create}
 */
type GatewaySubscriptionCreateDispatchData = GatewaySubscriptionModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#subscription-update}
 */
type GatewaySubscriptionUpdateDispatch = _DataPayload<GatewayDispatchEvents.SubscriptionUpdate, GatewaySubscriptionUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#subscription-update}
 */
type GatewaySubscriptionUpdateDispatchData = GatewaySubscriptionModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#subscription-delete}
 */
type GatewaySubscriptionDeleteDispatch = _DataPayload<GatewayDispatchEvents.SubscriptionDelete, GatewaySubscriptionDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#subscription-delete}
 */
type GatewaySubscriptionDeleteDispatchData = GatewaySubscriptionModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#channel-create}
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#channel-update}
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#channel-delete}
 */
type GatewayChannelModifyDispatchData = APIChannel & {
  type: Exclude<GuildChannelType, ThreadChannelType>;
  guild_id: Snowflake;
};
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#channel-create}
 */
type GatewayChannelCreateDispatch = _DataPayload<GatewayDispatchEvents.ChannelCreate, GatewayChannelCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#channel-create}
 */
type GatewayChannelCreateDispatchData = GatewayChannelModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#channel-update}
 */
type GatewayChannelUpdateDispatch = _DataPayload<GatewayDispatchEvents.ChannelUpdate, GatewayChannelUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#channel-update}
 */
type GatewayChannelUpdateDispatchData = GatewayChannelModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#channel-delete}
 */
type GatewayChannelDeleteDispatch = _DataPayload<GatewayDispatchEvents.ChannelDelete, GatewayChannelDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#channel-delete}
 */
type GatewayChannelDeleteDispatchData = GatewayChannelModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#channel-pins-update}
 */
type GatewayChannelPinsUpdateDispatch = _DataPayload<GatewayDispatchEvents.ChannelPinsUpdate, GatewayChannelPinsUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#channel-pins-update}
 */
interface GatewayChannelPinsUpdateDispatchData {
  /**
   * The id of the guild
   */
  guild_id?: Snowflake;
  /**
   * The id of the channel
   */
  channel_id: Snowflake;
  /**
   * The time at which the most recent pinned message was pinned
   */
  last_pin_timestamp?: string | null;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#entitlement-create}
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#entitlement-update}
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#entitlement-delete}
 */
type GatewayEntitlementModifyDispatchData = APIEntitlement;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#entitlement-create}
 */
type GatewayEntitlementCreateDispatchData = GatewayEntitlementModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#entitlement-create}
 */
type GatewayEntitlementCreateDispatch = _DataPayload<GatewayDispatchEvents.EntitlementCreate, GatewayEntitlementCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#entitlement-update}
 */
type GatewayEntitlementUpdateDispatchData = GatewayEntitlementModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#entitlement-update}
 */
type GatewayEntitlementUpdateDispatch = _DataPayload<GatewayDispatchEvents.EntitlementUpdate, GatewayEntitlementUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#entitlement-delete}
 */
type GatewayEntitlementDeleteDispatchData = GatewayEntitlementModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#entitlement-delete}
 */
type GatewayEntitlementDeleteDispatch = _DataPayload<GatewayDispatchEvents.EntitlementDelete, GatewayEntitlementDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-update}
 */
type GatewayGuildModifyDispatch = _DataPayload<GatewayDispatchEvents.GuildUpdate, GatewayGuildModifyDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-update}
 */
type GatewayGuildModifyDispatchData = APIGuild;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-create}
 */
type GatewayGuildCreateDispatch = _DataPayload<GatewayDispatchEvents.GuildCreate, GatewayGuildCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-create}
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-create-guild-create-extra-fields}
 */
interface GatewayGuildCreateDispatchData extends APIGuild {
  /**
   * When this guild was joined at
   *
   * **This field is only sent within the {@link https://discord.com/developers/docs/topics/gateway-events#guild-create | GUILD_CREATE} event**
   */
  joined_at: string;
  /**
   * `true` if this is considered a large guild
   *
   * **This field is only sent within the {@link https://discord.com/developers/docs/topics/gateway-events#guild-create | GUILD_CREATE} event**
   */
  large: boolean;
  /**
   * `true` if this guild is unavailable due to an outage
   */
  unavailable?: boolean;
  /**
   * Total number of members in this guild
   *
   * **This field is only sent within the {@link https://discord.com/developers/docs/topics/gateway-events#guild-create | GUILD_CREATE} event**
   */
  member_count: number;
  /**
   * States of members currently in voice channels; lacks the `guild_id` key
   *
   * **This field is only sent within the {@link https://discord.com/developers/docs/topics/gateway-events#guild-create | GUILD_CREATE} event**
   *
   * @see {@link https://discord.com/developers/docs/resources/voice#voice-state-object}
   */
  voice_states: APIBaseVoiceState[];
  /**
   * Users in the guild
   *
   * **This field is only sent within the {@link https://discord.com/developers/docs/topics/gateway-events#guild-create | GUILD_CREATE} event**
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
   */
  members: APIGuildMember[];
  /**
   * Channels in the guild
   *
   * **This field is only sent within the {@link https://discord.com/developers/docs/topics/gateway-events#guild-create | GUILD_CREATE} event**
   *
   * @see {@link https://discord.com/developers/docs/resources/channel#channel-object}
   */
  channels: (APIChannel & {
    type: Exclude<GuildChannelType, ThreadChannelType>;
  })[];
  /**
   * Threads in the guild
   *
   * **This field is only sent within the {@link https://discord.com/developers/docs/topics/gateway-events#guild-create | GUILD_CREATE} event**
   *
   * @see {@link https://discord.com/developers/docs/resources/channel#channel-object}
   */
  threads: (APIChannel & {
    type: ThreadChannelType;
  })[];
  /**
   * Presences of the members in the guild, will only include non-offline members if the size is greater than `large_threshold`
   *
   * **This field is only sent within the {@link https://discord.com/developers/docs/topics/gateway-events#guild-create | GUILD_CREATE} event**
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#presence-update}
   */
  presences: GatewayPresenceUpdate[];
  /**
   * The stage instances in the guild
   *
   * **This field is only sent within the {@link https://discord.com/developers/docs/topics/gateway-events#guild-create | GUILD_CREATE} event**
   *
   * @see {@link https://discord.com/developers/docs/resources/stage-instance#stage-instance-object-stage-instance-structure}
   */
  stage_instances: APIStageInstance[];
  /**
   * The scheduled events in the guild
   *
   * **This field is only sent within the {@link https://discord.com/developers/docs/topics/gateway-events#guild-create | GUILD_CREATE} event**
   *
   * @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-object}
   */
  guild_scheduled_events: APIGuildScheduledEvent[];
  /**
   * The soundboard sounds in the guild
   *
   * **This field is only sent within the {@link https://discord.com/developers/docs/topics/gateway-events#guild-create | GUILD_CREATE} event**
   *
   * @see {@link https://discord.com/developers/docs/resources/soundboard#soundboard-sound-object}
   */
  soundboard_sounds: APISoundboardSound[];
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-delete}
 */
type GatewayGuildDeleteDispatch = _DataPayload<GatewayDispatchEvents.GuildDelete, GatewayGuildDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-delete}
 */
interface GatewayGuildDeleteDispatchData extends APIBaseGuild {
  /**
   * `true` if this guild is unavailable due to an outage
   *
   * If the field is not set, the user was removed from the guild.
   */
  unavailable?: true;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-ban-add}
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-ban-remove}
 */
interface GatewayGuildBanModifyDispatchData {
  /**
   * ID of the guild
   */
  guild_id: Snowflake;
  /**
   * The banned user
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  user: APIUser;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-ban-add}
 */
type GatewayGuildBanAddDispatch = _DataPayload<GatewayDispatchEvents.GuildBanAdd, GatewayGuildBanAddDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-ban-add}
 */
type GatewayGuildBanAddDispatchData = GatewayGuildBanModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-ban-remove}
 */
type GatewayGuildBanRemoveDispatch = _DataPayload<GatewayDispatchEvents.GuildBanRemove, GatewayGuildBanRemoveDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-ban-remove}
 */
type GatewayGuildBanRemoveDispatchData = GatewayGuildBanModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-emojis-update}
 */
type GatewayGuildEmojisUpdateDispatch = _DataPayload<GatewayDispatchEvents.GuildEmojisUpdate, GatewayGuildEmojisUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-emojis-update}
 */
interface GatewayGuildEmojisUpdateDispatchData {
  /**
   * ID of the guild
   */
  guild_id: Snowflake;
  /**
   * Array of emojis
   *
   * @see {@link https://discord.com/developers/docs/resources/emoji#emoji-object}
   */
  emojis: APIEmoji[];
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-stickers-update}
 */
type GatewayGuildStickersUpdateDispatch = _DataPayload<GatewayDispatchEvents.GuildStickersUpdate, GatewayGuildStickersUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-stickers-update}
 */
interface GatewayGuildStickersUpdateDispatchData {
  /**
   * ID of the guild
   */
  guild_id: Snowflake;
  /**
   * Array of stickers
   *
   * @see {@link https://discord.com/developers/docs/resources/sticker#sticker-object}
   */
  stickers: APISticker[];
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-integrations-update}
 */
type GatewayGuildIntegrationsUpdateDispatch = _DataPayload<GatewayDispatchEvents.GuildIntegrationsUpdate, GatewayGuildIntegrationsUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-integrations-update}
 */
interface GatewayGuildIntegrationsUpdateDispatchData {
  /**
   * ID of the guild whose integrations were updated
   */
  guild_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-member-add}
 */
type GatewayGuildMemberAddDispatch = _DataPayload<GatewayDispatchEvents.GuildMemberAdd, GatewayGuildMemberAddDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-member-add}
 */
interface GatewayGuildMemberAddDispatchData extends APIGuildMember {
  /**
   * The id of the guild
   */
  guild_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-member-remove}
 */
type GatewayGuildMemberRemoveDispatch = _DataPayload<GatewayDispatchEvents.GuildMemberRemove, GatewayGuildMemberRemoveDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-member-remove}
 */
interface GatewayGuildMemberRemoveDispatchData {
  /**
   * The id of the guild
   */
  guild_id: Snowflake;
  /**
   * The user who was removed
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  user: APIUser;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-member-update}
 */
type GatewayGuildMemberUpdateDispatch = _DataPayload<GatewayDispatchEvents.GuildMemberUpdate, GatewayGuildMemberUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-member-update}
 */
interface GatewayGuildMemberUpdateDispatchData extends APIGuildMemberJoined, APIBaseGuildMember, Partial<APIBaseVoiceGuildMember>, Partial<APIFlaggedGuildMember>, Required<APIGuildMemberAvatar>, Required<APIGuildMemberUser> {
  /**
   * The id of the guild
   */
  guild_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-members-chunk}
 */
type GatewayGuildMembersChunkDispatch = _DataPayload<GatewayDispatchEvents.GuildMembersChunk, GatewayGuildMembersChunkDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-members-chunk}
 */
interface GatewayGuildMembersChunkDispatchData {
  /**
   * The id of the guild
   */
  guild_id: Snowflake;
  /**
   * Set of guild members
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
   */
  members: APIGuildMember[];
  /**
   * The chunk index in the expected chunks for this response (`0 <= chunk_index < chunk_count`)
   */
  chunk_index: number;
  /**
   * The total number of expected chunks for this response
   */
  chunk_count: number;
  /**
   * If passing an invalid id to `REQUEST_GUILD_MEMBERS`, it will be returned here
   */
  not_found?: unknown[];
  /**
   * If passing true to `REQUEST_GUILD_MEMBERS`, presences of the returned members will be here
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#update-presence}
   */
  presences?: GatewayGuildMembersChunkPresence[];
  /**
   * The nonce used in the Guild Members Request
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#request-guild-members}
   */
  nonce?: string;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-role-create}
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-role-update}
 */
interface GatewayGuildRoleModifyDispatchData {
  /**
   * The id of the guild
   */
  guild_id: Snowflake;
  /**
   * The role created or updated
   *
   * @see {@link https://discord.com/developers/docs/topics/permissions#role-object}
   */
  role: APIRole;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-role-create}
 */
type GatewayGuildRoleCreateDispatch = _DataPayload<GatewayDispatchEvents.GuildRoleCreate, GatewayGuildRoleCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-role-create}
 */
type GatewayGuildRoleCreateDispatchData = GatewayGuildRoleModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-role-update}
 */
type GatewayGuildRoleUpdateDispatch = _DataPayload<GatewayDispatchEvents.GuildRoleUpdate, GatewayGuildRoleUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-role-update}
 */
type GatewayGuildRoleUpdateDispatchData = GatewayGuildRoleModifyDispatchData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-role-delete}
 */
type GatewayGuildRoleDeleteDispatch = _DataPayload<GatewayDispatchEvents.GuildRoleDelete, GatewayGuildRoleDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-role-delete}
 */
interface GatewayGuildRoleDeleteDispatchData {
  /**
   * The id of the guild
   */
  guild_id: Snowflake;
  /**
   * The id of the role
   */
  role_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-scheduled-event-create}
 */
type GatewayGuildScheduledEventCreateDispatch = _DataPayload<GatewayDispatchEvents.GuildScheduledEventCreate, GatewayGuildScheduledEventCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-scheduled-event-create}
 */
type GatewayGuildScheduledEventCreateDispatchData = APIGuildScheduledEvent;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-scheduled-event-update}
 */
type GatewayGuildScheduledEventUpdateDispatch = _DataPayload<GatewayDispatchEvents.GuildScheduledEventUpdate, GatewayGuildScheduledEventUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-scheduled-event-update}
 */
type GatewayGuildScheduledEventUpdateDispatchData = APIGuildScheduledEvent;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-scheduled-event-delete}
 */
type GatewayGuildScheduledEventDeleteDispatch = _DataPayload<GatewayDispatchEvents.GuildScheduledEventDelete, GatewayGuildScheduledEventDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-scheduled-event-delete}
 */
type GatewayGuildScheduledEventDeleteDispatchData = APIGuildScheduledEvent;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-scheduled-event-user-add}
 */
type GatewayGuildScheduledEventUserAddDispatch = _DataPayload<GatewayDispatchEvents.GuildScheduledEventUserAdd, GatewayGuildScheduledEventUserAddDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-scheduled-event-user-add}
 */
interface GatewayGuildScheduledEventUserAddDispatchData {
  guild_scheduled_event_id: Snowflake;
  user_id: Snowflake;
  guild_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-scheduled-event-user-remove}
 */
type GatewayGuildScheduledEventUserRemoveDispatch = _DataPayload<GatewayDispatchEvents.GuildScheduledEventUserRemove, GatewayGuildScheduledEventUserRemoveDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-scheduled-event-user-remove}
 */
interface GatewayGuildScheduledEventUserRemoveDispatchData {
  guild_scheduled_event_id: Snowflake;
  user_id: Snowflake;
  guild_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-soundboard-sound-create}
 */
type GatewayGuildSoundboardSoundCreateDispatch = _DataPayload<GatewayDispatchEvents.GuildSoundboardSoundCreate, GatewayGuildSoundboardSoundCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-soundboard-sound-create}
 */
type GatewayGuildSoundboardSoundCreateDispatchData = APISoundboardSound;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-soundboard-sound-update}
 */
type GatewayGuildSoundboardSoundUpdateDispatch = _DataPayload<GatewayDispatchEvents.GuildSoundboardSoundUpdate, GatewayGuildSoundboardSoundUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-soundboard-sound-update}
 */
type GatewayGuildSoundboardSoundUpdateDispatchData = APISoundboardSound;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-soundboard-sound-delete}
 */
type GatewayGuildSoundboardSoundDeleteDispatch = _DataPayload<GatewayDispatchEvents.GuildSoundboardSoundDelete, GatewayGuildSoundboardSoundDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-soundboard-sound-delete}
 */
interface GatewayGuildSoundboardSoundDeleteDispatchData {
  /**
   * The id of the sound that was deleted
   */
  sound_id: Snowflake;
  /**
   * The id of the guild the sound was in
   */
  guild_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-soundboard-sounds-update}
 */
type GatewayGuildSoundboardSoundsUpdateDispatch = _DataPayload<GatewayDispatchEvents.GuildSoundboardSoundsUpdate, GatewayGuildSoundboardSoundsUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-soundboard-sounds-update}
 */
interface GatewayGuildSoundboardSoundsUpdateDispatchData {
  /**
   * The guild's soundboard sounds
   */
  soundboard_sounds: APISoundboardSound[];
  /**
   * The id of the guild
   */
  guild_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/events/gateway-events#soundboard-sounds}
 */
type GatewaySoundboardSoundsDispatch = _DataPayload<GatewayDispatchEvents.SoundboardSounds, GatewaySoundboardSoundsDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/events/gateway-events#soundboard-sounds}
 */
interface GatewaySoundboardSoundsDispatchData {
  /**
   * The guild's soundboard sounds
   */
  soundboard_sounds: APISoundboardSound[];
  /**
   * The id of the guild
   */
  guild_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#integration-create}
 */
type GatewayIntegrationCreateDispatch = _DataPayload<GatewayDispatchEvents.IntegrationCreate, GatewayIntegrationCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#integration-create}
 */
type GatewayIntegrationCreateDispatchData = APIGuildIntegration & {
  guild_id: Snowflake;
};
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#integration-update}
 */
type GatewayIntegrationUpdateDispatch = _DataPayload<GatewayDispatchEvents.IntegrationUpdate, GatewayIntegrationUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#integration-update}
 */
type GatewayIntegrationUpdateDispatchData = APIGuildIntegration & {
  guild_id: Snowflake;
};
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#integration-update}
 */
type GatewayIntegrationDeleteDispatch = _DataPayload<GatewayDispatchEvents.IntegrationDelete, GatewayIntegrationDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#integration-delete}
 */
interface GatewayIntegrationDeleteDispatchData {
  /**
   * Integration id
   */
  id: Snowflake;
  /**
   * ID of the guild
   */
  guild_id: Snowflake;
  /**
   * ID of the bot/OAuth2 application for this Discord integration
   */
  application_id?: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#interaction-create}
 */
type GatewayInteractionCreateDispatch = _DataPayload<GatewayDispatchEvents.InteractionCreate, GatewayInteractionCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#interaction-create}
 */
type GatewayInteractionCreateDispatchData = APIInteraction;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#invite-create}
 */
type GatewayInviteCreateDispatch = _DataPayload<GatewayDispatchEvents.InviteCreate, GatewayInviteCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#invite-create}
 */
interface GatewayInviteCreateDispatchData {
  /**
   * The channel the invite is for
   */
  channel_id: Snowflake;
  /**
   * The unique invite code
   *
   * @see {@link https://discord.com/developers/docs/resources/invite#invite-object}
   */
  code: string;
  /**
   * The time at which the invite was created
   */
  created_at: string;
  /**
   * The guild of the invite
   */
  guild_id?: Snowflake;
  /**
   * The user that created the invite
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  inviter?: APIUser;
  /**
   * How long the invite is valid for (in seconds)
   */
  max_age: number;
  /**
   * The maximum number of times the invite can be used
   */
  max_uses: number;
  /**
   * The type of target for this voice channel invite
   *
   * @see {@link https://discord.com/developers/docs/resources/invite#invite-object-invite-target-types}
   */
  target_type?: InviteTargetType;
  /**
   * The user whose stream to display for this voice channel stream invite
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  target_user?: APIUser;
  /**
   * The embedded application to open for this voice channel embedded application invite
   */
  target_application?: Partial<APIApplication>;
  /**
   * Whether or not the invite is temporary (invited users will be kicked on disconnect unless they're assigned a role)
   */
  temporary: boolean;
  /**
   * How many times the invite has been used (always will be `0`)
   */
  uses: 0;
  /**
   * The expiration date of this invite.
   */
  expires_at: string | null;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#invite-delete}
 */
type GatewayInviteDeleteDispatch = _DataPayload<GatewayDispatchEvents.InviteDelete, GatewayInviteDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#invite-delete}
 */
interface GatewayInviteDeleteDispatchData {
  /**
   * The channel of the invite
   */
  channel_id: Snowflake;
  /**
   * The guild of the invite
   */
  guild_id?: Snowflake;
  /**
   * The unique invite code
   *
   * @see {@link https://discord.com/developers/docs/resources/invite#invite-object}
   */
  code: string;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-create}
 */
type GatewayMessageCreateDispatch = _DataPayload<GatewayDispatchEvents.MessageCreate, GatewayMessageCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-create}
 */
interface GatewayMessageCreateDispatchData extends GatewayMessageEventExtraFields, APIBaseMessage {}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-update}
 */
type GatewayMessageUpdateDispatch = _DataPayload<GatewayDispatchEvents.MessageUpdate, GatewayMessageUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-update}
 */
interface GatewayMessageUpdateDispatchData extends GatewayMessageEventExtraFields, APIBaseMessage {}
interface APIGuildMemberNoUser extends APIBaseGuildMember, APIFlaggedGuildMember, APIGuildMemberAvatar, NonNullable<APIGuildMemberJoined>, APIBaseVoiceGuildMember {}
interface APIUserWithMember extends APIUser {
  /**
   * The `member` field is only present in `MESSAGE_CREATE` and `MESSAGE_UPDATE` events
   * from text-based guild channels
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
   */
  member?: APIGuildMemberNoUser;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-create-message-create-extra-fields}
 */
interface GatewayMessageEventExtraFields {
  /**
   * ID of the guild the message was sent in
   */
  guild_id?: Snowflake;
  /**
   * Member properties for this message's author
   *
   * The member object exists in `MESSAGE_CREATE` and `MESSAGE_UPDATE` events
   * from text-based guild channels
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
   */
  member?: APIGuildMemberNoUser;
  /**
   * Users specifically mentioned in the message
   *
   * @see {@link https://discord.com/developers/docs/resources/user#user-object}
   */
  mentions: APIUserWithMember[];
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-delete}
 */
type GatewayMessageDeleteDispatch = _DataPayload<GatewayDispatchEvents.MessageDelete, GatewayMessageDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-delete}
 */
interface GatewayMessageDeleteDispatchData {
  /**
   * The id of the message
   */
  id: Snowflake;
  /**
   * The id of the channel
   */
  channel_id: Snowflake;
  /**
   * The id of the guild
   */
  guild_id?: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-delete-bulk}
 */
type GatewayMessageDeleteBulkDispatch = _DataPayload<GatewayDispatchEvents.MessageDeleteBulk, GatewayMessageDeleteBulkDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-delete-bulk}
 */
interface GatewayMessageDeleteBulkDispatchData {
  /**
   * The ids of the messages
   */
  ids: Snowflake[];
  /**
   * The id of the channel
   */
  channel_id: Snowflake;
  /**
   * The id of the guild
   */
  guild_id?: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-reaction-add}
 */
interface GatewayMessageReactionAddDispatchData extends GatewayMessageReactionRemoveDispatchData {
  /**
   * The member who reacted if this happened in a guild
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
   */
  member?: APIGuildMember;
  /**
   * The id of the user that posted the message that was reacted to
   */
  message_author_id?: Snowflake;
  /**
   * Colors used for super-reaction animation in "#rrggbb" format
   */
  burst_colors?: string[];
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-reaction-add}
 */
type GatewayMessageReactionAddDispatch = _DataPayload<GatewayDispatchEvents.MessageReactionAdd, GatewayMessageReactionAddDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-reaction-remove}
 */
interface GatewayMessageReactionRemoveDispatchData {
  /**
   * The id of the user
   */
  user_id: Snowflake;
  /**
   * The id of the channel
   */
  channel_id: Snowflake;
  /**
   * The id of the message
   */
  message_id: Snowflake;
  /**
   * The id of the guild
   */
  guild_id?: Snowflake;
  /**
   * The emoji used to react
   *
   * @see {@link https://discord.com/developers/docs/resources/emoji#emoji-object}
   */
  emoji: APIEmoji;
  /**
   * True if this is a super-reaction
   */
  burst: boolean;
  /**
   * The type of reaction
   */
  type: ReactionType;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-reaction-remove}
 */
type GatewayMessageReactionRemoveDispatch = _DataPayload<GatewayDispatchEvents.MessageReactionRemove, GatewayMessageReactionRemoveDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-reaction-remove-all}
 */
type GatewayMessageReactionRemoveAllDispatch = _DataPayload<GatewayDispatchEvents.MessageReactionRemoveAll, GatewayMessageReactionRemoveAllDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-reaction-remove-all}
 */
type GatewayMessageReactionRemoveAllDispatchData = GatewayMessageReactionRemoveData;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-reaction-remove-emoji}
 */
type GatewayMessageReactionRemoveEmojiDispatch = _DataPayload<GatewayDispatchEvents.MessageReactionRemoveEmoji, GatewayMessageReactionRemoveEmojiDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-reaction-remove-emoji}
 */
interface GatewayMessageReactionRemoveEmojiDispatchData extends GatewayMessageReactionRemoveData {
  /**
   * The emoji that was removed
   */
  emoji: APIEmoji;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#presence-update}
 */
type GatewayPresenceUpdateDispatch = _DataPayload<GatewayDispatchEvents.PresenceUpdate, GatewayPresenceUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#presence-update}
 */
type GatewayPresenceUpdateDispatchData = GatewayPresenceUpdate;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#stage-instance-create}
 */
type GatewayStageInstanceCreateDispatch = _DataPayload<GatewayDispatchEvents.StageInstanceCreate, GatewayStageInstanceCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#stage-instance-create}
 */
type GatewayStageInstanceCreateDispatchData = APIStageInstance;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#stage-instance-delete}
 */
type GatewayStageInstanceDeleteDispatch = _DataPayload<GatewayDispatchEvents.StageInstanceDelete, GatewayStageInstanceDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#stage-instance-delete}
 */
type GatewayStageInstanceDeleteDispatchData = APIStageInstance;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#stage-instance-update}
 */
type GatewayStageInstanceUpdateDispatch = _DataPayload<GatewayDispatchEvents.StageInstanceUpdate, GatewayStageInstanceUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#stage-instance-update}
 */
type GatewayStageInstanceUpdateDispatchData = APIStageInstance;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-list-sync}
 */
type GatewayThreadListSyncDispatch = _DataPayload<GatewayDispatchEvents.ThreadListSync, GatewayThreadListSyncDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-list-sync}
 */
type GatewayThreadListSyncDispatchData = GatewayThreadListSync;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-members-update}
 */
type GatewayThreadMembersUpdateDispatch = _DataPayload<GatewayDispatchEvents.ThreadMembersUpdate, GatewayThreadMembersUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-members-update}
 */
type GatewayThreadMembersUpdateDispatchData = GatewayThreadMembersUpdate;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-member-update}
 */
type GatewayThreadMemberUpdateDispatch = _DataPayload<GatewayDispatchEvents.ThreadMemberUpdate, GatewayThreadMemberUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-member-update}
 */
type GatewayThreadMemberUpdateDispatchData = APIThreadMember & {
  guild_id: Snowflake;
};
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-create}
 */
type GatewayThreadCreateDispatch = _DataPayload<GatewayDispatchEvents.ThreadCreate, GatewayThreadCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-create}
 */
interface GatewayThreadCreateDispatchData extends APIThreadChannel {
  /**
   * Whether the thread is newly created or not.
   */
  newly_created?: true;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-update}
 */
type GatewayThreadUpdateDispatch = _DataPayload<GatewayDispatchEvents.ThreadUpdate, GatewayThreadUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-update}
 */
type GatewayThreadUpdateDispatchData = APIThreadChannel;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-delete}
 */
type GatewayThreadDeleteDispatch = _DataPayload<GatewayDispatchEvents.ThreadDelete, GatewayThreadDeleteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#thread-delete}
 */
interface GatewayThreadDeleteDispatchData {
  /**
   * The id of the channel
   */
  id: Snowflake;
  /**
   * The id of the guild
   */
  guild_id: Snowflake;
  /**
   * The id of the parent channel of the thread
   */
  parent_id: Snowflake;
  /**
   * The type of the channel
   *
   * @see {@link https://discord.com/developers/docs/resources/channel#channel-object-channel-types}
   */
  type: ChannelType;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#typing-start}
 */
type GatewayTypingStartDispatch = _DataPayload<GatewayDispatchEvents.TypingStart, GatewayTypingStartDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#typing-start}
 */
interface GatewayTypingStartDispatchData {
  /**
   * The id of the channel
   */
  channel_id: Snowflake;
  /**
   * The id of the guild
   */
  guild_id?: Snowflake;
  /**
   * The id of the user
   */
  user_id: Snowflake;
  /**
   * Unix time (in seconds) of when the user started typing
   */
  timestamp: number;
  /**
   * The member who started typing if this happened in a guild
   *
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
   */
  member?: APIGuildMember;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#user-update}
 */
type GatewayUserUpdateDispatch = _DataPayload<GatewayDispatchEvents.UserUpdate, GatewayUserUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#user-update}
 */
type GatewayUserUpdateDispatchData = APIUser;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#voice-channel-effect-send}
 */
type GatewayVoiceChannelEffectSendDispatch = _DataPayload<GatewayDispatchEvents.VoiceChannelEffectSend, GatewayVoiceChannelEffectSendDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#voice-channel-effect-send}
 */
interface GatewayVoiceChannelEffectSendDispatchData {
  /**
   * ID of the channel the effect was sent in
   */
  channel_id: Snowflake;
  /**
   * ID of the guild the effect was sent in
   */
  guild_id: Snowflake;
  /**
   * ID of the user who sent the effect
   */
  user_id: Snowflake;
  /**
   * The emoji sent, for emoji reaction and soundboard effects
   */
  emoji?: APIEmoji | null;
  /**
   * The type of emoji animation, for emoji reaction and soundboard effects
   */
  animation_type?: VoiceChannelEffectSendAnimationType | null;
  /**
   * The ID of the emoji animation, for emoji reaction and soundboard effects
   */
  animation_id?: number;
  /**
   * The ID of the soundboard sound, for soundboard effects
   */
  sound_id?: Snowflake | number;
  /**
   * The volume of the soundboard sound, from 0 to 1, for soundboard effects
   */
  sound_volume?: number;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#voice-channel-effect-send-animation-types}
 */
declare enum VoiceChannelEffectSendAnimationType {
  /**
   * A fun animation, sent by a Nitro subscriber
   */
  Premium = 0,
  /**
   * The standard animation
   */
  Basic = 1
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#voice-state-update}
 */
type GatewayVoiceStateUpdateDispatch = _DataPayload<GatewayDispatchEvents.VoiceStateUpdate, GatewayVoiceStateUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#voice-state-update}
 */
type GatewayVoiceStateUpdateDispatchData = APIVoiceState;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#voice-server-update}
 */
type GatewayVoiceServerUpdateDispatch = _DataPayload<GatewayDispatchEvents.VoiceServerUpdate, GatewayVoiceServerUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#voice-server-update}
 */
interface GatewayVoiceServerUpdateDispatchData {
  /**
   * Voice connection token
   */
  token: string;
  /**
   * The guild this voice server update is for
   */
  guild_id: Snowflake;
  /**
   * The voice server host
   *
   * A `null` endpoint means that the voice server allocated has gone away and is trying to be reallocated.
   * You should attempt to disconnect from the currently connected voice server, and not attempt to reconnect
   * until a new voice server is allocated
   */
  endpoint: string | null;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#webhooks-update}
 */
type GatewayWebhooksUpdateDispatch = _DataPayload<GatewayDispatchEvents.WebhooksUpdate, GatewayWebhooksUpdateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#webhooks-update}
 */
interface GatewayWebhooksUpdateDispatchData {
  /**
   * The id of the guild
   */
  guild_id: Snowflake;
  /**
   * The id of the channel
   */
  channel_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-audit-log-entry-create}
 */
type GatewayGuildAuditLogEntryCreateDispatch = _DataPayload<GatewayDispatchEvents.GuildAuditLogEntryCreate, GatewayGuildAuditLogEntryCreateDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-audit-log-entry-create}
 */
interface GatewayGuildAuditLogEntryCreateDispatchData extends APIAuditLogEntry {
  /**
   * ID of the guild
   */
  guild_id: Snowflake;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-poll-vote-add}
 */
type GatewayMessagePollVoteAddDispatch = _DataPayload<GatewayDispatchEvents.MessagePollVoteAdd, GatewayMessagePollVoteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-poll-vote-remove}
 */
type GatewayMessagePollVoteRemoveDispatch = _DataPayload<GatewayDispatchEvents.MessagePollVoteRemove, GatewayMessagePollVoteDispatchData>;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-poll-vote-add}
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#message-poll-vote-remove}
 */
interface GatewayMessagePollVoteDispatchData {
  /**
   * ID of the user
   */
  user_id: Snowflake;
  /**
   * ID of the channel
   */
  channel_id: Snowflake;
  /**
   * ID of the message
   */
  message_id: Snowflake;
  /**
   * ID of the guild
   */
  guild_id?: Snowflake;
  /**
   * ID of the answer
   */
  answer_id: number;
}
/**
 * @see {@link https://discord.com/developers/docs/events/gateway-events#rate-limited}
 */
type GatewayRateLimitedDispatch<Opcode extends keyof GatewayOpcodeRateLimitMetadataMap = keyof GatewayOpcodeRateLimitMetadataMap> = _DataPayload<GatewayDispatchEvents.RateLimited, GatewayRateLimitedDispatchData<Opcode>>;
/**
 * @see {@link https://discord.com/developers/docs/events/gateway-events#rate-limited}
 */
interface GatewayRateLimitedDispatchData<Opcode extends keyof GatewayOpcodeRateLimitMetadataMap = keyof GatewayOpcodeRateLimitMetadataMap> {
  /**
   * {@link GatewayOpcodes | Gateway opcode} of the event that was rate limited
   */
  opcode: Opcode;
  /**
   * The number of seconds to wait before submitting another request
   */
  retry_after: number;
  /**
   * Metadata for the event that was rate limited
   */
  meta: GatewayOpcodeRateLimitMetadataMap[Opcode];
}
/**
 * Map of gateway opcodes to their rate limit metadata types
 *
 * @see {@link https://discord.com/developers/docs/events/gateway-events#rate-limited-rate-limit-metadata-for-opcode-structure}
 */
interface GatewayOpcodeRateLimitMetadataMap {
  [GatewayOpcodes.RequestGuildMembers]: GatewayRequestGuildMemberRateLimitMetadata;
}
/**
 * Rate limit metadata for the {@link GatewayOpcodes.RequestGuildMembers} opcode
 */
interface GatewayRequestGuildMemberRateLimitMetadata {
  /**
   * Id of the guild members were requested for
   */
  guild_id: Snowflake;
  /**
   * Nonce used to identify the {@link GatewayGuildMembersChunkDispatch} response
   */
  nonce?: string;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway#sending-heartbeats}
 */
interface GatewayHeartbeat {
  op: GatewayOpcodes.Heartbeat;
  d: GatewayHeartbeatData;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway#sending-heartbeats}
 */
type GatewayHeartbeatData = number | null;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#identify}
 */
interface GatewayIdentify {
  op: GatewayOpcodes.Identify;
  d: GatewayIdentifyData;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#identify}
 */
interface GatewayIdentifyData {
  /**
   * Authentication token
   */
  token: string;
  /**
   * Connection properties
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#identify-identify-connection-properties}
   */
  properties: GatewayIdentifyProperties;
  /**
   * Whether this connection supports compression of packets
   *
   * @defaultValue `false`
   */
  compress?: boolean;
  /**
   * Value between 50 and 250, total number of members where the gateway will stop sending
   * offline members in the guild member list
   *
   * @defaultValue `50`
   */
  large_threshold?: number;
  /**
   * Used for Guild Sharding
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway#sharding}
   */
  shard?: [shard_id: number, shard_count: number];
  /**
   * Presence structure for initial presence information
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#update-presence}
   */
  presence?: GatewayPresenceUpdateData;
  /**
   * The Gateway Intents you wish to receive
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway#gateway-intents}
   */
  intents: number;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#identify-identify-connection-properties}
 */
interface GatewayIdentifyProperties {
  /**
   * Your operating system
   */
  os: string;
  /**
   * Your library name
   */
  browser: string;
  /**
   * Your library name
   */
  device: string;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#resume}
 */
interface GatewayResume {
  op: GatewayOpcodes.Resume;
  d: GatewayResumeData;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#resume}
 */
interface GatewayResumeData {
  /**
   * Session token
   */
  token: string;
  /**
   * Session id
   */
  session_id: string;
  /**
   * Last sequence number received
   */
  seq: number;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#request-guild-members}
 */
interface GatewayRequestGuildMembers {
  op: GatewayOpcodes.RequestGuildMembers;
  d: GatewayRequestGuildMembersData;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#request-guild-members}
 */
interface GatewayRequestGuildMembersDataBase {
  /**
   * ID of the guild to get members for
   */
  guild_id: Snowflake;
  /**
   * Used to specify if we want the presences of the matched members
   */
  presences?: boolean;
  /**
   * Nonce to identify the Guild Members Chunk response
   *
   * Nonce can only be up to 32 bytes. If you send an invalid nonce it will be ignored and the reply member_chunk(s) will not have a `nonce` set.
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#guild-members-chunk}
   */
  nonce?: string;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#request-guild-members}
 */
interface GatewayRequestGuildMembersDataWithUserIds extends GatewayRequestGuildMembersDataBase {
  /**
   * Used to specify which users you wish to fetch
   */
  user_ids: Snowflake | Snowflake[];
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#request-guild-members}
 */
interface GatewayRequestGuildMembersDataWithQuery extends GatewayRequestGuildMembersDataBase {
  /**
   * String that username starts with, or an empty string to return all members
   */
  query: string;
  /**
   * Maximum number of members to send matching the `query`;
   * a limit of `0` can be used with an empty string `query` to return all members
   */
  limit: number;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#request-guild-members}
 */
type GatewayRequestGuildMembersData = GatewayRequestGuildMembersDataWithQuery | GatewayRequestGuildMembersDataWithUserIds;
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#request-soundboard-sounds}
 */
interface GatewayRequestSoundboardSounds {
  op: GatewayOpcodes.RequestSoundboardSounds;
  d: GatewayRequestSoundboardSoundsData;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#request-soundboard-sounds}
 */
interface GatewayRequestSoundboardSoundsData {
  /**
   * The ids of the guilds to get soundboard sounds for
   */
  guild_ids: Snowflake[];
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#update-voice-state}
 */
interface GatewayVoiceStateUpdate {
  op: GatewayOpcodes.VoiceStateUpdate;
  d: GatewayVoiceStateUpdateData;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#update-voice-state}
 */
interface GatewayVoiceStateUpdateData {
  /**
   * ID of the guild
   */
  guild_id: Snowflake;
  /**
   * ID of the voice channel client wants to join (`null` if disconnecting)
   */
  channel_id: Snowflake | null;
  /**
   * Is the client muted
   */
  self_mute: boolean;
  /**
   * Is the client deafened
   */
  self_deaf: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#update-presence}
 */
interface GatewayUpdatePresence {
  op: GatewayOpcodes.PresenceUpdate;
  d: GatewayPresenceUpdateData;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#update-presence-gateway-presence-update-structure}
 */
interface GatewayPresenceUpdateData {
  /**
   * Unix time (in milliseconds) of when the client went idle, or `null` if the client is not idle
   */
  since: number | null;
  /**
   * The user's activities
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object}
   */
  activities: GatewayActivityUpdateData[];
  /**
   * The user's new status
   *
   * @see {@link https://discord.com/developers/docs/topics/gateway-events#update-presence-status-types}
   */
  status: PresenceUpdateStatus;
  /**
   * Whether or not the client is afk
   */
  afk: boolean;
}
/**
 * @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-structure}
 */
type GatewayActivityUpdateData = Pick<GatewayActivity, 'name' | 'state' | 'type' | 'url'>;
interface _BaseBasePayload {
  /**
   * Opcode for the payload
   */
  op: GatewayOpcodes;
  /**
   * Event data
   */
  d?: unknown;
}
interface _BasePayload {
  /**
   * Sequence number, used for resuming sessions and heartbeats
   */
  s: number;
  /**
   * The event name for this payload
   */
  t?: string;
}
interface _NonDispatchPayload extends _BaseBasePayload {
  t: null;
  s: null;
}
interface _DataPayload<Event extends GatewayDispatchEvents, D = unknown> extends _BasePayload {
  op: GatewayOpcodes.Dispatch;
  t: Event;
  d: D;
}
interface GatewayMessageReactionRemoveData {
  /**
   * The id of the channel
   */
  channel_id: Snowflake;
  /**
   * The id of the message
   */
  message_id: Snowflake;
  /**
   * The id of the guild
   */
  guild_id?: Snowflake;
}
//#endregion
//#region extensions/discord/src/internal/commands.d.ts
type ConditionalCommandOption = (interaction: unknown) => boolean;
type CommandOption = Record<string, unknown> & {
  name: string;
  description?: string;
  type: ApplicationCommandOptionType;
  required?: boolean;
  choices?: Array<{
    name: string;
    value: string | number | boolean;
  }>;
  autocomplete?: boolean | ((interaction: AutocompleteInteraction) => Promise<void>);
};
type CommandOptions = CommandOption[];
declare abstract class BaseCommand {
  id?: string;
  abstract name: string;
  description?: string;
  nameLocalizations?: Record<string, string>;
  descriptionLocalizations?: Record<string, string>;
  defer: boolean | ConditionalCommandOption;
  ephemeral: boolean | ConditionalCommandOption;
  abstract type: ApplicationCommandType;
  integrationTypes: number[];
  contexts: InteractionContextType[];
  permission?: bigint | bigint[];
  components?: BaseMessageInteractiveComponent[];
  guildIds?: string[];
  abstract serializeOptions(): unknown[] | undefined;
  serialize(): RESTPostAPIApplicationCommandsJSONBody;
}
declare abstract class Command extends BaseCommand {
  options?: CommandOptions;
  type: ApplicationCommandType;
  abstract run(interaction: unknown): unknown;
  autocomplete(interaction: unknown): Promise<void>;
  preCheck(interaction: unknown): Promise<unknown>;
  serializeOptions(): unknown[];
}
//#endregion
//#region extensions/discord/src/internal/command-deploy.d.ts
type DeployCommandOptions = {
  mode?: "overwrite" | "reconcile";
  force?: boolean;
};
//#endregion
//#region extensions/discord/src/internal/event-queue.d.ts
type DiscordEventQueueOptions = {
  maxQueueSize?: number;
  maxConcurrency?: number;
  listenerTimeout?: number;
  slowListenerThreshold?: number;
};
//#endregion
//#region extensions/discord/src/internal/client.d.ts
interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: `/${string}`;
  handler(req: Request, ctx?: Context): Response | Promise<Response>;
  protected?: boolean;
  disabled?: boolean;
}
interface Context {
  waitUntil?(promise: Promise<unknown>): void;
  env?: unknown;
}
declare abstract class Plugin {
  abstract readonly id: string;
  registerClient?(client: Client): Promise<void> | void;
  registerRoutes?(client: Client): Promise<void> | void;
  onRequest?(req: Request, ctx: Context): Promise<Response | undefined> | Response | undefined;
}
type AnyListener = {
  type: string;
  handle(data: unknown, client: Client): Promise<void> | void;
};
interface ClientOptions {
  baseUrl: string;
  clientId: string;
  deploySecret?: string;
  publicKey: string | string[];
  token: string;
  requestOptions?: RequestClientOptions;
  autoDeploy?: boolean;
  disableDeployRoute?: boolean;
  disableInteractionsRoute?: boolean;
  disableEventsRoute?: boolean;
  commandDeployHashStorePath?: string;
  devGuilds?: string[];
  eventQueue?: DiscordEventQueueOptions;
  restCacheTtlMs?: number;
}
type OneOffComponentResult = {
  success: true;
  customId: string;
  message: Message;
  values?: string[];
} | {
  success: false;
  message: Message;
  reason: "timed out";
};
declare class ComponentRegistry<T extends {
  customId: string;
  customIdParser?: typeof parseCustomId;
  type?: number;
}> {
  private entries;
  private oneOffComponents;
  private wildcardEntries;
  register(entry: T): void;
  resolve(customId: string, options?: {
    componentType?: number;
  }): T | undefined;
  waitForMessageComponent(message: Message, timeoutMs: number): Promise<OneOffComponentResult>;
  resolveOneOffComponent(params: {
    channelId?: string;
    customId: string;
    messageId?: string;
    values?: string[];
  }): boolean;
}
declare class Client {
  routes: Route[];
  plugins: Array<{
    id: string;
    plugin: Plugin;
  }>;
  options: ClientOptions;
  commands: BaseCommand[];
  listeners: AnyListener[];
  rest: RequestClient;
  componentHandler: ComponentRegistry<BaseMessageInteractiveComponent>;
  private commandDeployer;
  private entityCache;
  private eventQueue?;
  modalHandler: ComponentRegistry<Modal>;
  shardId?: number;
  totalShards?: number;
  constructor(options: ClientOptions, handlers: {
    commands?: BaseCommand[];
    listeners?: AnyListener[];
    components?: BaseMessageInteractiveComponent[];
    modals?: Modal[];
  }, plugins?: Plugin[]);
  getPlugin<T = Plugin>(id: string): T | undefined;
  registerListener(listener: AnyListener): AnyListener;
  unregisterListener(listener: AnyListener): boolean;
  getRuntimeMetrics(): {
    request: {
      globalRateLimitUntil: number;
      activeBuckets: number;
      routeBucketMappings: number;
      buckets: {
        key: string;
        active: number;
        bucket: string | undefined;
        invalidRequests: number;
        pending: number;
        pendingByLane: {
          [k: string]: number;
        };
        rateLimitHits: number;
        remaining: number | undefined;
        resetAt: number;
        routeKeyCount: number;
      }[];
      invalidRequestCount: number;
      invalidRequestCountByStatus: Record<number, number>;
      queueSize: number;
      queueSizeByLane: {
        critical: number;
        background: number;
        standard: number;
      };
      droppedByLane: {
        critical: number;
        background: number;
        standard: number;
      };
      oldestQueuedByLane: {
        [k: string]: number;
      };
      activeWorkers: number;
      maxConcurrentWorkers: number;
    };
    eventQueue: {
      queueSize: number;
      processing: number;
      processed: number;
      dropped: number;
      timeouts: number;
      maxQueueSize: number;
      maxConcurrency: number;
    } | undefined;
  };
  fetchUser(id: string): Promise<User>;
  fetchChannel(id: string): Promise<(APIAnnouncementThreadChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGroupDMChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildCategoryChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildForumChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildMediaChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildStageVoiceChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildVoiceChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APINewsChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIPrivateThreadChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIPublicThreadChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APITextChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  })>;
  fetchGuild(id: string): Promise<Guild>;
  fetchMember(guildId: string, userId: string): Promise<GuildMember>;
  getDiscordCommands(): Promise<APIApplicationCommand[]>;
  deployCommands(options?: DeployCommandOptions): Promise<{
    mode: "overwrite" | "reconcile";
    usedDevGuilds: boolean;
  }>;
  reconcileCommands(): Promise<{
    mode: "overwrite" | "reconcile";
    usedDevGuilds: boolean;
  }>;
  handleInteraction(rawData: APIInteraction, _ctx?: Context): Promise<void>;
  dispatchGatewayEvent(type: string, data: unknown): Promise<void>;
}
//#endregion
//#region extensions/discord/src/internal/listeners.d.ts
type DiscordMessageDispatchData = {
  id?: string;
  channel_id: string;
  channelId?: string;
  guild_id?: string;
  message: Message;
  author: User | null;
  member?: {
    roles?: string[];
    nick?: string | null;
    nickname?: string | null;
  };
  rawMember?: {
    roles?: string[];
    nick?: string | null;
    nickname?: string | null;
  };
  guild?: Guild | null;
  channel?: unknown;
};
declare abstract class BaseListener {
  abstract readonly type: string;
  abstract handle(data: unknown, client: Client): Promise<void> | void;
}
declare abstract class MessageCreateListener extends BaseListener {
  readonly type = GatewayDispatchEvents.MessageCreate;
  abstract handle(data: DiscordMessageDispatchData, client: Client): Promise<void> | void;
}
//#endregion
//#region extensions/discord/src/monitor/allow-list.d.ts
type DiscordAllowList = {
  allowAll: boolean;
  ids: Set<string>;
  names: Set<string>;
};
type DiscordChannelOverrideConfig = {
  requireMention?: boolean;
  ignoreOtherMentions?: boolean;
  skills?: string[];
  enabled?: boolean;
  users?: string[];
  roles?: string[];
  systemPrompt?: string;
  includeThreadStarter?: boolean;
  autoThread?: boolean;
  autoThreadName?: "message" | "generated";
  autoArchiveDuration?: "60" | "1440" | "4320" | "10080" | 60 | 1440 | 4320 | 10080;
};
type DiscordGuildEntryResolved = {
  id?: string;
  slug?: string;
  requireMention?: boolean;
  ignoreOtherMentions?: boolean;
  reactionNotifications?: "off" | "own" | "all" | "allowlist";
  users?: string[];
  roles?: string[];
  channels?: Record<string, DiscordChannelOverrideConfig>;
};
type DiscordChannelConfigResolved = DiscordChannelOverrideConfig & {
  allowed: boolean;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};
declare function normalizeDiscordAllowList(raw: string[] | undefined, prefixes: string[]): {
  allowAll: boolean;
  ids: Set<string>;
  names: Set<string>;
} | null;
declare function normalizeDiscordSlug(value: string): string;
declare function allowListMatches(list: DiscordAllowList, candidate: {
  id?: string;
  name?: string;
  tag?: string;
}, params?: {
  allowNameMatching?: boolean;
}): boolean;
declare function resolveDiscordCommandAuthorized(params: {
  isDirectMessage: boolean;
  allowFrom?: string[];
  guildInfo?: DiscordGuildEntryResolved | null;
  author: User;
  allowNameMatching?: boolean;
}): boolean;
declare function resolveDiscordGuildEntry(params: {
  guild?: Guild<true> | Guild | null;
  guildId?: string | null;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}): DiscordGuildEntryResolved | null;
type DiscordChannelScope = "channel" | "thread";
declare function resolveDiscordChannelConfig(params: {
  guildInfo?: DiscordGuildEntryResolved | null;
  channelId: string;
  channelName?: string;
  channelSlug: string;
}): DiscordChannelConfigResolved | null;
declare function resolveDiscordChannelConfigWithFallback(params: {
  guildInfo?: DiscordGuildEntryResolved | null;
  channelId: string;
  channelName?: string;
  channelSlug: string;
  parentId?: string;
  parentName?: string;
  parentSlug?: string;
  scope?: DiscordChannelScope;
}): DiscordChannelConfigResolved | null;
declare function resolveDiscordShouldRequireMention(params: {
  isGuildMessage: boolean;
  isThread: boolean;
  botId?: string | null;
  threadOwnerId?: string | null;
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null; /** Pass pre-computed value to avoid redundant checks. */
  isAutoThreadOwnedByBot?: boolean;
}): boolean;
declare function isDiscordGroupAllowedByPolicy(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  guildAllowlisted: boolean;
  channelAllowlistConfigured: boolean;
  channelAllowed: boolean;
}): boolean;
declare function resolveGroupDmAllow(params: {
  channels?: string[];
  channelId: string;
  channelName?: string;
  channelSlug: string;
}): boolean;
declare function shouldEmitDiscordReactionNotification(params: {
  mode?: "off" | "own" | "all" | "allowlist";
  botId?: string;
  messageAuthorId?: string;
  userId: string;
  userName?: string;
  userTag?: string;
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  memberRoleIds?: string[];
  allowlist?: string[];
  allowNameMatching?: boolean;
}): boolean;
//#endregion
//#region extensions/discord/src/monitor/listeners.d.ts
type DiscordMessageEvent$1 = Parameters<MessageCreateListener["handle"]>[0];
type DiscordMessageHandler = (data: DiscordMessageEvent$1, client: Client, options?: {
  abortSignal?: AbortSignal;
}) => Promise<void>;
declare function registerDiscordListener(listeners: Array<object>, listener: object): boolean;
//#endregion
//#region extensions/discord/src/monitor/message-channel-info.d.ts
type DiscordChannelInfo = {
  type: ChannelType;
  name?: string;
  topic?: string;
  parentId?: string;
  ownerId?: string;
};
//#endregion
//#region extensions/discord/src/monitor/message-media.d.ts
declare function buildDiscordMediaPayload(mediaList: Array<{
  path: string;
  contentType?: string;
}>): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
};
//#endregion
//#region extensions/discord/src/monitor/reply-delivery.d.ts
type DiscordThreadBindingLookupRecord = {
  accountId: string;
  channelId: string;
  threadId: string;
  agentId: string;
  label?: string;
  webhookId?: string;
  webhookToken?: string;
};
type DiscordThreadBindingLookup = {
  listBySessionKey: (targetSessionKey: string) => DiscordThreadBindingLookupRecord[];
  touchThread?: (params: {
    threadId: string;
    at?: number;
    persist?: boolean;
  }) => unknown;
};
//#endregion
//#region extensions/discord/src/monitor/sender-identity.d.ts
type DiscordSenderIdentity = {
  id: string;
  name?: string;
  tag?: string;
  label: string;
  isPluralKit: boolean;
  pluralkit?: {
    memberId: string;
    memberName?: string;
    systemId?: string;
    systemName?: string;
  };
};
//#endregion
//#region extensions/discord/src/monitor/threading.types.d.ts
type DiscordThreadChannel = {
  id: string;
  name?: string | null;
  parentId?: string | null;
  parent?: {
    id?: string;
    name?: string;
  };
  ownerId?: string | null;
};
//#endregion
//#region extensions/discord/src/monitor/threading.starter.d.ts
declare function resolveDiscordReplyTarget(opts: {
  replyToMode: ReplyToMode;
  replyToId?: string;
  hasReplied: boolean;
}): string | undefined;
declare function sanitizeDiscordThreadName(rawName: string, fallbackId: string): string;
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight.types.d.ts
type LoadedConfig = OpenClawConfig;
type RuntimeEnv = RuntimeEnv$1;
type DiscordMessageEvent = DiscordMessageEvent$1;
type DiscordMessagePreflightSharedFields = {
  cfg: LoadedConfig;
  discordConfig: NonNullable<OpenClawConfig["channels"]>["discord"];
  accountId: string;
  token: string;
  runtime: RuntimeEnv;
  botUserId?: string;
  abortSignal?: AbortSignal;
  guildHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  mediaMaxBytes: number;
  textLimit: number;
  replyToMode: ReplyToMode;
  ackReactionScope: "all" | "direct" | "group-all" | "group-mentions" | "off" | "none";
  groupPolicy: "open" | "disabled" | "allowlist";
};
type DiscordMessagePreflightContext = DiscordMessagePreflightSharedFields & {
  data: DiscordMessageEvent;
  client: Client;
  message: DiscordMessageEvent["message"];
  messageChannelId: string;
  author: User;
  sender: DiscordSenderIdentity;
  canonicalMessageId?: string;
  memberRoleIds: string[];
  channelInfo: DiscordChannelInfo | null;
  channelName?: string;
  isGuildMessage: boolean;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  commandAuthorized: boolean;
  baseText: string;
  messageText: string;
  preflightAudioTranscript?: string;
  wasMentioned: boolean;
  route: ReturnType<typeof resolveAgentRoute>;
  threadBinding?: SessionBindingRecord;
  boundSessionKey?: string;
  boundAgentId?: string;
  guildInfo: DiscordGuildEntryResolved | null;
  guildSlug: string;
  threadChannel: DiscordThreadChannel | null;
  threadParentId?: string;
  threadParentName?: string;
  threadParentType?: ChannelType;
  threadName?: string | null;
  configChannelName?: string;
  configChannelSlug: string;
  displayChannelName?: string;
  displayChannelSlug: string;
  baseSessionKey: string;
  channelConfig: DiscordChannelConfigResolved | null;
  channelAllowlistConfigured: boolean;
  channelAllowed: boolean;
  shouldRequireMention: boolean;
  hasAnyMention: boolean;
  hasControlCommand: boolean;
  allowTextCommands: boolean;
  shouldBypassMention: boolean;
  effectiveWasMentioned: boolean;
  inboundEventKind: InboundEventKind;
  canDetectMention: boolean;
  historyEntry?: HistoryEntry;
  threadBindings: DiscordThreadBindingLookup;
  discordRestFetch?: typeof fetch;
  botLoopProtection?: ChannelBotLoopProtectionFacts;
};
type DiscordMessagePreflightParams = DiscordMessagePreflightSharedFields & {
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: string[];
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: string[];
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  ackReactionScope: DiscordMessagePreflightContext["ackReactionScope"];
  groupPolicy: DiscordMessagePreflightContext["groupPolicy"];
  threadBindings: DiscordThreadBindingLookup;
  discordRestFetch?: typeof fetch;
  data: DiscordMessageEvent;
  client: Client;
};
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight.d.ts
declare function preflightDiscordMessage(params: DiscordMessagePreflightParams): Promise<DiscordMessagePreflightContext | null>;
//#endregion
//#region extensions/discord/src/monitor/message-handler.process.d.ts
type DiscordMessageProcessObserver = {
  onFinalReplyStart?: () => void;
  onFinalReplyDelivered?: () => void;
  onReplyPlanResolved?: (params: {
    createdThreadId?: string;
    sessionKey?: string;
  }) => void;
};
declare function processDiscordMessage(ctx: DiscordMessagePreflightContext, observer?: DiscordMessageProcessObserver): Promise<void>;
//#endregion
//#region extensions/discord/src/monitor/status.d.ts
type DiscordMonitorStatusPatch = {
  connected?: boolean;
  lastEventAt?: number | null;
  lastTransportActivityAt?: number | null;
  lastConnectedAt?: number | null;
  lastDisconnect?: string | {
    at: number;
    status?: number;
    error?: string;
    loggedOut?: boolean;
  } | null;
  lastInboundAt?: number | null;
  lastError?: string | null;
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
};
type DiscordMonitorStatusSink = (patch: DiscordMonitorStatusPatch) => void;
//#endregion
//#region extensions/discord/src/monitor/message-run-queue.d.ts
type ProcessDiscordMessage = typeof processDiscordMessage;
type DiscordMessageRunQueueTestingHooks = {
  processDiscordMessage?: ProcessDiscordMessage;
};
//#endregion
//#region extensions/discord/src/monitor/message-handler.d.ts
type PreflightDiscordMessage = typeof preflightDiscordMessage;
type DiscordMessageHandlerParams = Omit<DiscordMessagePreflightParams, "ackReactionScope" | "groupPolicy" | "data" | "client"> & {
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  testing?: DiscordMessageHandlerTestingHooks;
};
type DiscordMessageHandlerTestingHooks = DiscordMessageRunQueueTestingHooks & {
  preflightDiscordMessage?: PreflightDiscordMessage;
};
type DiscordMessageHandlerWithLifecycle = DiscordMessageHandler & {
  deactivate: () => void;
};
declare function createDiscordMessageHandler(params: DiscordMessageHandlerParams): DiscordMessageHandlerWithLifecycle;
//#endregion
//#region extensions/discord/src/monitor/native-command.types.d.ts
type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];
//#endregion
//#region extensions/discord/src/monitor/native-command.d.ts
declare function createDiscordNativeCommand(params: {
  command: NativeCommandSpec;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  ephemeralDefault: boolean;
  threadBindings: ThreadBindingManager;
}): Command;
//#endregion
//#region node_modules/agent-base/dist/index.d.ts
interface HttpConnectOpts extends net.TcpNetConnectOpts {
  secureEndpoint: false;
  protocol?: string;
}
interface HttpsConnectOpts extends tls.ConnectionOptions {
  secureEndpoint: true;
  protocol?: string;
  port: number;
}
type AgentConnectOpts = HttpConnectOpts | HttpsConnectOpts;
declare const INTERNAL: unique symbol;
declare abstract class Agent extends http.Agent {
  private [INTERNAL];
  options: Partial<net.TcpNetConnectOpts & tls.ConnectionOptions>;
  keepAlive: boolean;
  constructor(opts?: http.AgentOptions);
  abstract connect(req: http.ClientRequest, options: AgentConnectOpts): Promise<Duplex | http.Agent> | Duplex | http.Agent;
  /**
   * Determine whether this is an `http` or `https` request.
   */
  isSecureEndpoint(options?: AgentConnectOpts): boolean;
  private incrementSockets;
  private decrementSockets;
  getName(options?: AgentConnectOpts): string;
  createSocket(req: http.ClientRequest, options: AgentConnectOpts, cb: (err: Error | null, s?: Duplex) => void): void;
  createConnection(): Duplex;
  get defaultPort(): number;
  set defaultPort(v: number);
  get protocol(): string;
  set protocol(v: string);
}
//#endregion
//#region node_modules/https-proxy-agent/dist/index.d.ts
type Protocol<T> = T extends `${infer Protocol}:${infer _}` ? Protocol : never;
type ConnectOptsMap = {
  http: Omit<net.TcpNetConnectOpts, 'host' | 'port'>;
  https: Omit<tls.ConnectionOptions, 'host' | 'port'>;
};
type ConnectOpts<T> = { [P in keyof ConnectOptsMap]: Protocol<T> extends P ? ConnectOptsMap[P] : never }[keyof ConnectOptsMap];
type HttpsProxyAgentOptions<T> = ConnectOpts<T> & http.AgentOptions & {
  headers?: OutgoingHttpHeaders | (() => OutgoingHttpHeaders);
};
/**
 * The `HttpsProxyAgent` implements an HTTP Agent subclass that connects to
 * the specified "HTTP(s) proxy server" in order to proxy HTTPS requests.
 *
 * Outgoing HTTP requests are first tunneled through the proxy server using the
 * `CONNECT` HTTP request method to establish a connection to the proxy server,
 * and then the proxy server connects to the destination target and issues the
 * HTTP request from the proxy server.
 *
 * `https:` requests have their socket connection upgraded to TLS once
 * the connection to the proxy server has been established.
 */
declare class HttpsProxyAgent<Uri extends string> extends Agent {
  static protocols: readonly ["http", "https"];
  readonly proxy: URL;
  proxyHeaders: OutgoingHttpHeaders | (() => OutgoingHttpHeaders);
  connectOpts: net.TcpNetConnectOpts & tls.ConnectionOptions;
  constructor(proxy: Uri | URL, opts?: HttpsProxyAgentOptions<Uri>);
  /**
   * Called when the node-core HTTP client library is creating a
   * new HTTP request.
   */
  connect(req: http.ClientRequest, opts: AgentConnectOpts): Promise<net.Socket>;
}
//#endregion
//#region extensions/discord/src/internal/gateway.d.ts
type UpdatePresenceData = Omit<GatewayPresenceUpdateData, "status"> & {
  status: "online" | "idle" | "dnd" | "invisible" | "offline";
};
type UpdateVoiceStateData = GatewayVoiceStateUpdateData;
type RequestGuildMembersData = {
  guild_id: string;
  query?: string;
  limit: number;
  presences?: boolean;
  user_ids?: string | string[];
  nonce?: string;
};
type GatewayPluginOptions = {
  reconnect?: {
    maxAttempts?: number;
  };
  intents?: number;
  autoInteractions?: boolean;
  shard?: [number, number];
  url?: string;
};
declare class GatewayPlugin extends Plugin {
  readonly id = "gateway";
  protected client?: Client;
  readonly options: Required<Pick<GatewayPluginOptions, "autoInteractions">> & GatewayPluginOptions;
  ws: ws.WebSocket | null;
  sequence: number | null;
  lastHeartbeatAck: boolean;
  emitter: EventEmitter<any>;
  shardId?: number;
  totalShards?: number;
  protected gatewayInfo?: APIGatewayBotInfo;
  isConnected: boolean;
  private sessionId;
  private resumeGatewayUrl;
  private reconnectAttempts;
  private shouldReconnect;
  private isConnecting;
  private readonly heartbeatTimers;
  private readonly reconnectTimer;
  private outboundLimiter;
  constructor(options: GatewayPluginOptions, gatewayInfo?: APIGatewayBotInfo);
  get ping(): number | null;
  get heartbeatInterval(): NodeJS.Timeout | undefined;
  set heartbeatInterval(timer: NodeJS.Timeout | undefined);
  get firstHeartbeatTimeout(): NodeJS.Timeout | undefined;
  set firstHeartbeatTimeout(timer: NodeJS.Timeout | undefined);
  registerClient(client: Client): Promise<void>;
  connect(resume?: boolean): void;
  disconnect(): void;
  protected createWebSocket(url: string): ws.WebSocket;
  private setupWebSocket;
  private handlePayload;
  private startHeartbeat;
  private stopHeartbeat;
  private stopReconnectTimer;
  private sendHeartbeat;
  private identify;
  private identifyWithConcurrency;
  send(payload: GatewaySendPayload | GatewayReceivePayload, skipRateLimit?: boolean): void;
  private sendSerializedGatewayEvent;
  private handleDispatch;
  private resetSessionState;
  private scheduleReconnect;
  updatePresence(data: UpdatePresenceData): void;
  updateVoiceState(data: UpdateVoiceStateData): void;
  requestGuildMembers(data: RequestGuildMembersData): void;
  getRateLimitStatus(): {
    remainingEvents: number;
    resetTime: number;
    currentEventCount: number;
    queuedEvents: number;
  };
  getIntentsInfo(): {
    intents: number;
    hasGuilds: boolean;
    hasGuildMembers: boolean;
    hasGuildPresences: boolean;
    hasGuildMessages: boolean;
    hasMessageContent: boolean;
  };
  hasIntent(intent: number): boolean;
}
//#endregion
//#region extensions/discord/src/monitor/gateway-plugin.d.ts
type DiscordGatewayWebSocketCtor = new (url: string, options?: {
  agent?: unknown;
  handshakeTimeout?: number;
}) => ws.WebSocket;
type DiscordGatewayClient = Parameters<GatewayPlugin["registerClient"]>[0];
type GatewayPluginTestingOptions = {
  registerClient?: (plugin: GatewayPlugin, client: DiscordGatewayClient) => Promise<void>;
  webSocketCtor?: DiscordGatewayWebSocketCtor;
};
type CreateDiscordGatewayPluginTestingOptions = GatewayPluginTestingOptions & {
  HttpsProxyAgentCtor?: typeof HttpsProxyAgent;
};
type ResolveDiscordGatewayIntentsParams = {
  intentsConfig?: DiscordIntentsConfig;
  voiceEnabled?: boolean;
};
declare function resolveDiscordGatewayIntents(params?: ResolveDiscordGatewayIntentsParams): number;
declare function waitForDiscordGatewayPluginRegistration(plugin: unknown): Promise<void> | undefined;
declare function createDiscordGatewayPlugin(params: {
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv$1;
  testing?: CreateDiscordGatewayPluginTestingOptions;
}): GatewayPlugin;
//#endregion
//#region extensions/discord/src/monitor/provider.d.ts
type MonitorDiscordOpts = {
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv$1;
  channelRuntime?: ChannelRuntimeSurface;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  historyLimit?: number;
  replyToMode?: ReplyToMode;
  setStatus?: DiscordMonitorStatusSink;
};
declare function monitorDiscordProvider(opts?: MonitorDiscordOpts): Promise<void>;
//#endregion
//#region extensions/discord/src/monitor/gateway-registry.d.ts
/** Register a GatewayPlugin instance for an account. */
declare function registerGateway(accountId: string | undefined, gateway: GatewayPlugin): void;
/** Unregister a GatewayPlugin instance for an account. */
declare function unregisterGateway(accountId?: string): void;
/** Get the GatewayPlugin for an account. Returns undefined if not registered. */
declare function getGateway(accountId?: string): GatewayPlugin | undefined;
/** Clear all registered gateways (for testing). */
declare function clearGateways(): void;
//#endregion
//#region extensions/discord/src/monitor/presence-cache.d.ts
/** Update cached presence for a user. */
declare function setPresence(accountId: string | undefined, userId: string, data: GatewayPresenceUpdate): void;
/** Get cached presence for a user. Returns undefined if not cached. */
declare function getPresence(accountId: string | undefined, userId: string): GatewayPresenceUpdate | undefined;
/** Clear cached presence data. */
declare function clearPresences(accountId?: string): void;
/** Get the number of cached presence entries. */
declare function presenceCacheSize(): number;
//#endregion
export { resolveDiscordChannelConfigWithFallback as A, DiscordChannelConfigResolved as C, normalizeDiscordAllowList as D, isDiscordGroupAllowedByPolicy as E, shouldEmitDiscordReactionNotification as F, resolveDiscordGuildEntry as M, resolveDiscordShouldRequireMention as N, normalizeDiscordSlug as O, resolveGroupDmAllow as P, DiscordAllowList as S, allowListMatches as T, sanitizeDiscordThreadName as _, clearGateways as a, DiscordMessageHandler as b, unregisterGateway as c, createDiscordGatewayPlugin as d, resolveDiscordGatewayIntents as f, resolveDiscordReplyTarget as g, createDiscordMessageHandler as h, setPresence as i, resolveDiscordCommandAuthorized as j, resolveDiscordChannelConfig as k, MonitorDiscordOpts as l, createDiscordNativeCommand as m, getPresence as n, getGateway as o, waitForDiscordGatewayPluginRegistration as p, presenceCacheSize as r, registerGateway as s, clearPresences as t, monitorDiscordProvider as u, buildDiscordMediaPayload as v, DiscordGuildEntryResolved as w, registerDiscordListener as x, DiscordMessageEvent$1 as y };