import { o as __toESM, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { t as privateFileStore } from "./private-file-store-DMtyjgoc.js";
import "./security-runtime-CcSekjBd.js";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
//#region node_modules/discord-api-types/gateway/v10.js
var require_v10$5 = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/topics/gateway
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.VoiceChannelEffectSendAnimationType = exports.GatewayDispatchEvents = exports.GatewayIntentBits = exports.GatewayCloseCodes = exports.GatewayOpcodes = exports.GatewayVersion = void 0;
	exports.GatewayVersion = "10";
	/**
	* @see {@link https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-opcodes}
	*/
	var GatewayOpcodes;
	(function(GatewayOpcodes) {
		/**
		* An event was dispatched
		*/
		GatewayOpcodes[GatewayOpcodes["Dispatch"] = 0] = "Dispatch";
		/**
		* A bidirectional opcode to maintain an active gateway connection.
		* Fired periodically by the client, or fired by the gateway to request an immediate heartbeat from the client.
		*/
		GatewayOpcodes[GatewayOpcodes["Heartbeat"] = 1] = "Heartbeat";
		/**
		* Starts a new session during the initial handshake
		*/
		GatewayOpcodes[GatewayOpcodes["Identify"] = 2] = "Identify";
		/**
		* Update the client's presence
		*/
		GatewayOpcodes[GatewayOpcodes["PresenceUpdate"] = 3] = "PresenceUpdate";
		/**
		* Used to join/leave or move between voice channels
		*/
		GatewayOpcodes[GatewayOpcodes["VoiceStateUpdate"] = 4] = "VoiceStateUpdate";
		/**
		* Resume a previous session that was disconnected
		*/
		GatewayOpcodes[GatewayOpcodes["Resume"] = 6] = "Resume";
		/**
		* You should attempt to reconnect and resume immediately
		*/
		GatewayOpcodes[GatewayOpcodes["Reconnect"] = 7] = "Reconnect";
		/**
		* Request information about offline guild members in a large guild
		*/
		GatewayOpcodes[GatewayOpcodes["RequestGuildMembers"] = 8] = "RequestGuildMembers";
		/**
		* The session has been invalidated. You should reconnect and identify/resume accordingly
		*/
		GatewayOpcodes[GatewayOpcodes["InvalidSession"] = 9] = "InvalidSession";
		/**
		* Sent immediately after connecting, contains the `heartbeat_interval` to use
		*/
		GatewayOpcodes[GatewayOpcodes["Hello"] = 10] = "Hello";
		/**
		* Sent in response to receiving a heartbeat to acknowledge that it has been received
		*/
		GatewayOpcodes[GatewayOpcodes["HeartbeatAck"] = 11] = "HeartbeatAck";
		/**
		* Request information about soundboard sounds in a set of guilds
		*/
		GatewayOpcodes[GatewayOpcodes["RequestSoundboardSounds"] = 31] = "RequestSoundboardSounds";
	})(GatewayOpcodes || (exports.GatewayOpcodes = GatewayOpcodes = {}));
	/**
	* @see {@link https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes}
	*/
	var GatewayCloseCodes;
	(function(GatewayCloseCodes) {
		/**
		* We're not sure what went wrong. Try reconnecting?
		*/
		GatewayCloseCodes[GatewayCloseCodes["UnknownError"] = 4e3] = "UnknownError";
		/**
		* You sent an invalid Gateway opcode or an invalid payload for an opcode. Don't do that!
		*
		* @see {@link https://discord.com/developers/docs/topics/gateway-events#payload-structure}
		*/
		GatewayCloseCodes[GatewayCloseCodes["UnknownOpcode"] = 4001] = "UnknownOpcode";
		/**
		* You sent an invalid payload to us. Don't do that!
		*
		* @see {@link https://discord.com/developers/docs/topics/gateway#sending-events}
		*/
		GatewayCloseCodes[GatewayCloseCodes["DecodeError"] = 4002] = "DecodeError";
		/**
		* You sent us a payload prior to identifying
		*
		* @see {@link https://discord.com/developers/docs/topics/gateway-events#identify}
		*/
		GatewayCloseCodes[GatewayCloseCodes["NotAuthenticated"] = 4003] = "NotAuthenticated";
		/**
		* The account token sent with your identify payload is incorrect
		*
		* @see {@link https://discord.com/developers/docs/topics/gateway-events#identify}
		*/
		GatewayCloseCodes[GatewayCloseCodes["AuthenticationFailed"] = 4004] = "AuthenticationFailed";
		/**
		* You sent more than one identify payload. Don't do that!
		*/
		GatewayCloseCodes[GatewayCloseCodes["AlreadyAuthenticated"] = 4005] = "AlreadyAuthenticated";
		/**
		* The sequence sent when resuming the session was invalid. Reconnect and start a new session
		*
		* @see {@link https://discord.com/developers/docs/topics/gateway-events#resume}
		*/
		GatewayCloseCodes[GatewayCloseCodes["InvalidSeq"] = 4007] = "InvalidSeq";
		/**
		* Woah nelly! You're sending payloads to us too quickly. Slow it down! You will be disconnected on receiving this
		*/
		GatewayCloseCodes[GatewayCloseCodes["RateLimited"] = 4008] = "RateLimited";
		/**
		* Your session timed out. Reconnect and start a new one
		*/
		GatewayCloseCodes[GatewayCloseCodes["SessionTimedOut"] = 4009] = "SessionTimedOut";
		/**
		* You sent us an invalid shard when identifying
		*
		* @see {@link https://discord.com/developers/docs/topics/gateway#sharding}
		*/
		GatewayCloseCodes[GatewayCloseCodes["InvalidShard"] = 4010] = "InvalidShard";
		/**
		* The session would have handled too many guilds - you are required to shard your connection in order to connect
		*
		* @see {@link https://discord.com/developers/docs/topics/gateway#sharding}
		*/
		GatewayCloseCodes[GatewayCloseCodes["ShardingRequired"] = 4011] = "ShardingRequired";
		/**
		* You sent an invalid version for the gateway
		*/
		GatewayCloseCodes[GatewayCloseCodes["InvalidAPIVersion"] = 4012] = "InvalidAPIVersion";
		/**
		* You sent an invalid intent for a Gateway Intent. You may have incorrectly calculated the bitwise value
		*
		* @see {@link https://discord.com/developers/docs/topics/gateway#gateway-intents}
		*/
		GatewayCloseCodes[GatewayCloseCodes["InvalidIntents"] = 4013] = "InvalidIntents";
		/**
		* You sent a disallowed intent for a Gateway Intent. You may have tried to specify an intent that you have not
		* enabled or are not whitelisted for
		*
		* @see {@link https://discord.com/developers/docs/topics/gateway#gateway-intents}
		* @see {@link https://discord.com/developers/docs/topics/gateway#privileged-intents}
		*/
		GatewayCloseCodes[GatewayCloseCodes["DisallowedIntents"] = 4014] = "DisallowedIntents";
	})(GatewayCloseCodes || (exports.GatewayCloseCodes = GatewayCloseCodes = {}));
	/**
	* @see {@link https://discord.com/developers/docs/topics/gateway#list-of-intents}
	*/
	var GatewayIntentBits;
	(function(GatewayIntentBits) {
		GatewayIntentBits[GatewayIntentBits["Guilds"] = 1] = "Guilds";
		GatewayIntentBits[GatewayIntentBits["GuildMembers"] = 2] = "GuildMembers";
		GatewayIntentBits[GatewayIntentBits["GuildModeration"] = 4] = "GuildModeration";
		/**
		* @deprecated This is the old name for {@link GatewayIntentBits.GuildModeration}
		*/
		GatewayIntentBits[GatewayIntentBits["GuildBans"] = 4] = "GuildBans";
		GatewayIntentBits[GatewayIntentBits["GuildExpressions"] = 8] = "GuildExpressions";
		/**
		* @deprecated This is the old name for {@link GatewayIntentBits.GuildExpressions}
		*/
		GatewayIntentBits[GatewayIntentBits["GuildEmojisAndStickers"] = 8] = "GuildEmojisAndStickers";
		GatewayIntentBits[GatewayIntentBits["GuildIntegrations"] = 16] = "GuildIntegrations";
		GatewayIntentBits[GatewayIntentBits["GuildWebhooks"] = 32] = "GuildWebhooks";
		GatewayIntentBits[GatewayIntentBits["GuildInvites"] = 64] = "GuildInvites";
		GatewayIntentBits[GatewayIntentBits["GuildVoiceStates"] = 128] = "GuildVoiceStates";
		GatewayIntentBits[GatewayIntentBits["GuildPresences"] = 256] = "GuildPresences";
		GatewayIntentBits[GatewayIntentBits["GuildMessages"] = 512] = "GuildMessages";
		GatewayIntentBits[GatewayIntentBits["GuildMessageReactions"] = 1024] = "GuildMessageReactions";
		GatewayIntentBits[GatewayIntentBits["GuildMessageTyping"] = 2048] = "GuildMessageTyping";
		GatewayIntentBits[GatewayIntentBits["DirectMessages"] = 4096] = "DirectMessages";
		GatewayIntentBits[GatewayIntentBits["DirectMessageReactions"] = 8192] = "DirectMessageReactions";
		GatewayIntentBits[GatewayIntentBits["DirectMessageTyping"] = 16384] = "DirectMessageTyping";
		GatewayIntentBits[GatewayIntentBits["MessageContent"] = 32768] = "MessageContent";
		GatewayIntentBits[GatewayIntentBits["GuildScheduledEvents"] = 65536] = "GuildScheduledEvents";
		GatewayIntentBits[GatewayIntentBits["AutoModerationConfiguration"] = 1048576] = "AutoModerationConfiguration";
		GatewayIntentBits[GatewayIntentBits["AutoModerationExecution"] = 2097152] = "AutoModerationExecution";
		GatewayIntentBits[GatewayIntentBits["GuildMessagePolls"] = 16777216] = "GuildMessagePolls";
		GatewayIntentBits[GatewayIntentBits["DirectMessagePolls"] = 33554432] = "DirectMessagePolls";
	})(GatewayIntentBits || (exports.GatewayIntentBits = GatewayIntentBits = {}));
	/**
	* @see {@link https://discord.com/developers/docs/topics/gateway-events#receive-events}
	*/
	var GatewayDispatchEvents;
	(function(GatewayDispatchEvents) {
		GatewayDispatchEvents["ApplicationCommandPermissionsUpdate"] = "APPLICATION_COMMAND_PERMISSIONS_UPDATE";
		GatewayDispatchEvents["AutoModerationActionExecution"] = "AUTO_MODERATION_ACTION_EXECUTION";
		GatewayDispatchEvents["AutoModerationRuleCreate"] = "AUTO_MODERATION_RULE_CREATE";
		GatewayDispatchEvents["AutoModerationRuleDelete"] = "AUTO_MODERATION_RULE_DELETE";
		GatewayDispatchEvents["AutoModerationRuleUpdate"] = "AUTO_MODERATION_RULE_UPDATE";
		GatewayDispatchEvents["ChannelCreate"] = "CHANNEL_CREATE";
		GatewayDispatchEvents["ChannelDelete"] = "CHANNEL_DELETE";
		GatewayDispatchEvents["ChannelPinsUpdate"] = "CHANNEL_PINS_UPDATE";
		GatewayDispatchEvents["ChannelUpdate"] = "CHANNEL_UPDATE";
		GatewayDispatchEvents["EntitlementCreate"] = "ENTITLEMENT_CREATE";
		GatewayDispatchEvents["EntitlementDelete"] = "ENTITLEMENT_DELETE";
		GatewayDispatchEvents["EntitlementUpdate"] = "ENTITLEMENT_UPDATE";
		GatewayDispatchEvents["GuildAuditLogEntryCreate"] = "GUILD_AUDIT_LOG_ENTRY_CREATE";
		GatewayDispatchEvents["GuildBanAdd"] = "GUILD_BAN_ADD";
		GatewayDispatchEvents["GuildBanRemove"] = "GUILD_BAN_REMOVE";
		GatewayDispatchEvents["GuildCreate"] = "GUILD_CREATE";
		GatewayDispatchEvents["GuildDelete"] = "GUILD_DELETE";
		GatewayDispatchEvents["GuildEmojisUpdate"] = "GUILD_EMOJIS_UPDATE";
		GatewayDispatchEvents["GuildIntegrationsUpdate"] = "GUILD_INTEGRATIONS_UPDATE";
		GatewayDispatchEvents["GuildMemberAdd"] = "GUILD_MEMBER_ADD";
		GatewayDispatchEvents["GuildMemberRemove"] = "GUILD_MEMBER_REMOVE";
		GatewayDispatchEvents["GuildMembersChunk"] = "GUILD_MEMBERS_CHUNK";
		GatewayDispatchEvents["GuildMemberUpdate"] = "GUILD_MEMBER_UPDATE";
		GatewayDispatchEvents["GuildRoleCreate"] = "GUILD_ROLE_CREATE";
		GatewayDispatchEvents["GuildRoleDelete"] = "GUILD_ROLE_DELETE";
		GatewayDispatchEvents["GuildRoleUpdate"] = "GUILD_ROLE_UPDATE";
		GatewayDispatchEvents["GuildScheduledEventCreate"] = "GUILD_SCHEDULED_EVENT_CREATE";
		GatewayDispatchEvents["GuildScheduledEventDelete"] = "GUILD_SCHEDULED_EVENT_DELETE";
		GatewayDispatchEvents["GuildScheduledEventUpdate"] = "GUILD_SCHEDULED_EVENT_UPDATE";
		GatewayDispatchEvents["GuildScheduledEventUserAdd"] = "GUILD_SCHEDULED_EVENT_USER_ADD";
		GatewayDispatchEvents["GuildScheduledEventUserRemove"] = "GUILD_SCHEDULED_EVENT_USER_REMOVE";
		GatewayDispatchEvents["GuildSoundboardSoundCreate"] = "GUILD_SOUNDBOARD_SOUND_CREATE";
		GatewayDispatchEvents["GuildSoundboardSoundDelete"] = "GUILD_SOUNDBOARD_SOUND_DELETE";
		GatewayDispatchEvents["GuildSoundboardSoundsUpdate"] = "GUILD_SOUNDBOARD_SOUNDS_UPDATE";
		GatewayDispatchEvents["GuildSoundboardSoundUpdate"] = "GUILD_SOUNDBOARD_SOUND_UPDATE";
		GatewayDispatchEvents["SoundboardSounds"] = "SOUNDBOARD_SOUNDS";
		GatewayDispatchEvents["GuildStickersUpdate"] = "GUILD_STICKERS_UPDATE";
		GatewayDispatchEvents["GuildUpdate"] = "GUILD_UPDATE";
		GatewayDispatchEvents["IntegrationCreate"] = "INTEGRATION_CREATE";
		GatewayDispatchEvents["IntegrationDelete"] = "INTEGRATION_DELETE";
		GatewayDispatchEvents["IntegrationUpdate"] = "INTEGRATION_UPDATE";
		GatewayDispatchEvents["InteractionCreate"] = "INTERACTION_CREATE";
		GatewayDispatchEvents["InviteCreate"] = "INVITE_CREATE";
		GatewayDispatchEvents["InviteDelete"] = "INVITE_DELETE";
		GatewayDispatchEvents["MessageCreate"] = "MESSAGE_CREATE";
		GatewayDispatchEvents["MessageDelete"] = "MESSAGE_DELETE";
		GatewayDispatchEvents["MessageDeleteBulk"] = "MESSAGE_DELETE_BULK";
		GatewayDispatchEvents["MessagePollVoteAdd"] = "MESSAGE_POLL_VOTE_ADD";
		GatewayDispatchEvents["MessagePollVoteRemove"] = "MESSAGE_POLL_VOTE_REMOVE";
		GatewayDispatchEvents["MessageReactionAdd"] = "MESSAGE_REACTION_ADD";
		GatewayDispatchEvents["MessageReactionRemove"] = "MESSAGE_REACTION_REMOVE";
		GatewayDispatchEvents["MessageReactionRemoveAll"] = "MESSAGE_REACTION_REMOVE_ALL";
		GatewayDispatchEvents["MessageReactionRemoveEmoji"] = "MESSAGE_REACTION_REMOVE_EMOJI";
		GatewayDispatchEvents["MessageUpdate"] = "MESSAGE_UPDATE";
		GatewayDispatchEvents["PresenceUpdate"] = "PRESENCE_UPDATE";
		GatewayDispatchEvents["RateLimited"] = "RATE_LIMITED";
		GatewayDispatchEvents["Ready"] = "READY";
		GatewayDispatchEvents["Resumed"] = "RESUMED";
		GatewayDispatchEvents["StageInstanceCreate"] = "STAGE_INSTANCE_CREATE";
		GatewayDispatchEvents["StageInstanceDelete"] = "STAGE_INSTANCE_DELETE";
		GatewayDispatchEvents["StageInstanceUpdate"] = "STAGE_INSTANCE_UPDATE";
		GatewayDispatchEvents["SubscriptionCreate"] = "SUBSCRIPTION_CREATE";
		GatewayDispatchEvents["SubscriptionDelete"] = "SUBSCRIPTION_DELETE";
		GatewayDispatchEvents["SubscriptionUpdate"] = "SUBSCRIPTION_UPDATE";
		GatewayDispatchEvents["ThreadCreate"] = "THREAD_CREATE";
		GatewayDispatchEvents["ThreadDelete"] = "THREAD_DELETE";
		GatewayDispatchEvents["ThreadListSync"] = "THREAD_LIST_SYNC";
		GatewayDispatchEvents["ThreadMembersUpdate"] = "THREAD_MEMBERS_UPDATE";
		GatewayDispatchEvents["ThreadMemberUpdate"] = "THREAD_MEMBER_UPDATE";
		GatewayDispatchEvents["ThreadUpdate"] = "THREAD_UPDATE";
		GatewayDispatchEvents["TypingStart"] = "TYPING_START";
		GatewayDispatchEvents["UserUpdate"] = "USER_UPDATE";
		GatewayDispatchEvents["VoiceChannelEffectSend"] = "VOICE_CHANNEL_EFFECT_SEND";
		GatewayDispatchEvents["VoiceServerUpdate"] = "VOICE_SERVER_UPDATE";
		GatewayDispatchEvents["VoiceStateUpdate"] = "VOICE_STATE_UPDATE";
		GatewayDispatchEvents["WebhooksUpdate"] = "WEBHOOKS_UPDATE";
	})(GatewayDispatchEvents || (exports.GatewayDispatchEvents = GatewayDispatchEvents = {}));
	/**
	* @see {@link https://discord.com/developers/docs/topics/gateway-events#voice-channel-effect-send-animation-types}
	*/
	var VoiceChannelEffectSendAnimationType;
	(function(VoiceChannelEffectSendAnimationType) {
		/**
		* A fun animation, sent by a Nitro subscriber
		*/
		VoiceChannelEffectSendAnimationType[VoiceChannelEffectSendAnimationType["Premium"] = 0] = "Premium";
		/**
		* The standard animation
		*/
		VoiceChannelEffectSendAnimationType[VoiceChannelEffectSendAnimationType["Basic"] = 1] = "Basic";
	})(VoiceChannelEffectSendAnimationType || (exports.VoiceChannelEffectSendAnimationType = VoiceChannelEffectSendAnimationType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/globals.js
var require_globals = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.FormattingPatterns = void 0;
	const timestampStyles = "DFRSTdfst";
	const timestampLength = 13;
	/**
	* @see {@link https://discord.com/developers/docs/reference#message-formatting-formats}
	*/
	exports.FormattingPatterns = {
		/**
		* Regular expression for matching a user mention, strictly without a nickname
		*
		* The `id` group property is present on the `exec` result of this expression
		*/
		User: /<@(?<id>\d{17,20})>/,
		/**
		* Regular expression for matching a user mention, strictly with a nickname
		*
		* The `id` group property is present on the `exec` result of this expression
		*
		* @deprecated Passing `!` in user mentions is no longer necessary / supported, and future message contents won't have it
		*/
		UserWithNickname: /<@!(?<id>\d{17,20})>/,
		/**
		* Regular expression for matching a user mention, with or without a nickname
		*
		* The `id` group property is present on the `exec` result of this expression
		*
		* @deprecated Passing `!` in user mentions is no longer necessary / supported, and future message contents won't have it
		*/
		UserWithOptionalNickname: /<@!?(?<id>\d{17,20})>/,
		/**
		* Regular expression for matching a channel mention
		*
		* The `id` group property is present on the `exec` result of this expression
		*/
		Channel: /<#(?<id>\d{17,20})>/,
		/**
		* Regular expression for matching a role mention
		*
		* The `id` group property is present on the `exec` result of this expression
		*/
		Role: /<@&(?<id>\d{17,20})>/,
		/**
		* Regular expression for matching a application command mention
		*
		* The `fullName` (possibly including `name`, `subcommandOrGroup` and `subcommand`) and `id` group properties are present on the `exec` result of this expression
		*/
		SlashCommand: /<\/(?<fullName>(?<name>[-_\p{Letter}\p{Number}\p{sc=Deva}\p{sc=Thai}]{1,32})(?: (?<subcommandOrGroup>[-_\p{Letter}\p{Number}\p{sc=Deva}\p{sc=Thai}]{1,32}))?(?: (?<subcommand>[-_\p{Letter}\p{Number}\p{sc=Deva}\p{sc=Thai}]{1,32}))?):(?<id>\d{17,20})>/u,
		/**
		* Regular expression for matching a custom emoji, either static or animated
		*
		* The `animated`, `name` and `id` group properties are present on the `exec` result of this expression
		*/
		Emoji: /<(?<animated>a)?:(?<name>\w{2,32}):(?<id>\d{17,20})>/,
		/**
		* Regular expression for matching strictly an animated custom emoji
		*
		* The `animated`, `name` and `id` group properties are present on the `exec` result of this expression
		*/
		AnimatedEmoji: /<(?<animated>a):(?<name>\w{2,32}):(?<id>\d{17,20})>/,
		/**
		* Regular expression for matching strictly a static custom emoji
		*
		* The `name` and `id` group properties are present on the `exec` result of this expression
		*/
		StaticEmoji: /<:(?<name>\w{2,32}):(?<id>\d{17,20})>/,
		/**
		* Regular expression for matching a timestamp, either default or custom styled
		*
		* The `timestamp` and `style` group properties are present on the `exec` result of this expression
		*/
		Timestamp: new RegExp(`<t:(?<timestamp>-?\\d{1,${timestampLength}})(:(?<style>[${timestampStyles}]))?>`),
		/**
		* Regular expression for matching strictly default styled timestamps
		*
		* The `timestamp` group property is present on the `exec` result of this expression
		*/
		DefaultStyledTimestamp: new RegExp(`<t:(?<timestamp>-?\\d{1,${timestampLength}})>`),
		/**
		* Regular expression for matching strictly custom styled timestamps
		*
		* The `timestamp` and `style` group properties are present on the `exec` result of this expression
		*/
		StyledTimestamp: new RegExp(`<t:(?<timestamp>-?\\d{1,${timestampLength}}):(?<style>[${timestampStyles}])>`),
		/**
		* Regular expression for matching a guild navigation mention
		*
		* The `type` group property is present on the `exec` result of this expression
		*/
		GuildNavigation: /<id:(?<type>customize|browse|guide|linked-roles)>/,
		/**
		* Regular expression for matching a linked role mention
		*
		* The `id` group property is present on the `exec` result of this expression
		*/
		LinkedRole: /<id:linked-roles:(?<id>\d{17,20})>/
	};
	/**
	* Freezes the formatting patterns
	*
	* @internal
	*/
	Object.freeze(exports.FormattingPatterns);
}));
//#endregion
//#region node_modules/discord-api-types/payloads/common.js
var require_common$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.PermissionFlagsBits = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/topics/permissions#permissions-bitwise-permission-flags}
	*
	* These flags are exported as `BigInt`s and NOT numbers. Wrapping them in `Number()`
	* may cause issues, try to use BigInts as much as possible or modules that can
	* replicate them in some way
	*/
	exports.PermissionFlagsBits = {
		/**
		* Allows creation of instant invites
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		CreateInstantInvite: 1n << 0n,
		/**
		* Allows kicking members
		*/
		KickMembers: 1n << 1n,
		/**
		* Allows banning members
		*/
		BanMembers: 1n << 2n,
		/**
		* Allows all permissions and bypasses channel permission overwrites
		*/
		Administrator: 1n << 3n,
		/**
		* Allows management and editing of channels
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		ManageChannels: 1n << 4n,
		/**
		* Allows management and editing of the guild
		*/
		ManageGuild: 1n << 5n,
		/**
		* Allows for the addition of reactions to messages. This permission does not apply to reacting with an existing reaction on a message
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		AddReactions: 1n << 6n,
		/**
		* Allows for viewing of audit logs
		*/
		ViewAuditLog: 1n << 7n,
		/**
		* Allows for using priority speaker in a voice channel
		*
		* Applies to channel types: Voice
		*/
		PrioritySpeaker: 1n << 8n,
		/**
		* Allows the user to go live
		*
		* Applies to channel types: Voice, Stage
		*/
		Stream: 1n << 9n,
		/**
		* Allows guild members to view a channel, which includes reading messages in text channels and joining voice channels
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		ViewChannel: 1n << 10n,
		/**
		* Allows for sending messages in a channel and creating threads in a forum
		* (does not allow sending messages in threads)
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		SendMessages: 1n << 11n,
		/**
		* Allows for sending of `/tts` messages
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		SendTTSMessages: 1n << 12n,
		/**
		* Allows for deletion of other users messages
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		ManageMessages: 1n << 13n,
		/**
		* Links sent by users with this permission will be auto-embedded
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		EmbedLinks: 1n << 14n,
		/**
		* Allows for uploading images and files
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		AttachFiles: 1n << 15n,
		/**
		* Allows for reading of message history
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		ReadMessageHistory: 1n << 16n,
		/**
		* Allows for using the `@everyone` tag to notify all users in a channel,
		* and the `@here` tag to notify all online users in a channel
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		MentionEveryone: 1n << 17n,
		/**
		* Allows the usage of custom emojis from other servers
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		UseExternalEmojis: 1n << 18n,
		/**
		* Allows for viewing guild insights
		*/
		ViewGuildInsights: 1n << 19n,
		/**
		* Allows for joining of a voice channel
		*
		* Applies to channel types: Voice, Stage
		*/
		Connect: 1n << 20n,
		/**
		* Allows for speaking in a voice channel
		*
		* Applies to channel types: Voice
		*/
		Speak: 1n << 21n,
		/**
		* Allows for muting members in a voice channel
		*
		* Applies to channel types: Voice, Stage
		*/
		MuteMembers: 1n << 22n,
		/**
		* Allows for deafening of members in a voice channel
		*
		* Applies to channel types: Voice
		*/
		DeafenMembers: 1n << 23n,
		/**
		* Allows for moving of members between voice channels
		*
		* Applies to channel types: Voice, Stage
		*/
		MoveMembers: 1n << 24n,
		/**
		* Allows for using voice-activity-detection in a voice channel
		*
		* Applies to channel types: Voice
		*/
		UseVAD: 1n << 25n,
		/**
		* Allows for modification of own nickname
		*/
		ChangeNickname: 1n << 26n,
		/**
		* Allows for modification of other users nicknames
		*/
		ManageNicknames: 1n << 27n,
		/**
		* Allows management and editing of roles
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		ManageRoles: 1n << 28n,
		/**
		* Allows management and editing of webhooks
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		ManageWebhooks: 1n << 29n,
		/**
		* Allows management and editing of emojis, stickers, and soundboard sounds
		*
		* @deprecated This is the old name for {@link PermissionFlagsBits.ManageGuildExpressions}
		*/
		ManageEmojisAndStickers: 1n << 30n,
		/**
		* Allows for editing and deleting emojis, stickers, and soundboard sounds created by all users
		*/
		ManageGuildExpressions: 1n << 30n,
		/**
		* Allows members to use application commands, including slash commands and context menu commands
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		UseApplicationCommands: 1n << 31n,
		/**
		* Allows for requesting to speak in stage channels
		*
		* Applies to channel types: Stage
		*/
		RequestToSpeak: 1n << 32n,
		/**
		* Allows for editing and deleting scheduled events created by all users
		*
		* Applies to channel types: Voice, Stage
		*/
		ManageEvents: 1n << 33n,
		/**
		* Allows for deleting and archiving threads, and viewing all private threads
		*
		* Applies to channel types: Text
		*/
		ManageThreads: 1n << 34n,
		/**
		* Allows for creating public and announcement threads
		*
		* Applies to channel types: Text
		*/
		CreatePublicThreads: 1n << 35n,
		/**
		* Allows for creating private threads
		*
		* Applies to channel types: Text
		*/
		CreatePrivateThreads: 1n << 36n,
		/**
		* Allows the usage of custom stickers from other servers
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		UseExternalStickers: 1n << 37n,
		/**
		* Allows for sending messages in threads
		*
		* Applies to channel types: Text
		*/
		SendMessagesInThreads: 1n << 38n,
		/**
		* Allows for using Activities (applications with the {@link ApplicationFlags.Embedded} flag)
		*
		* Applies to channel types: Text, Voice
		*/
		UseEmbeddedActivities: 1n << 39n,
		/**
		* Allows for timing out users to prevent them from sending or reacting to messages in chat and threads,
		* and from speaking in voice and stage channels
		*/
		ModerateMembers: 1n << 40n,
		/**
		* Allows for viewing role subscription insights
		*/
		ViewCreatorMonetizationAnalytics: 1n << 41n,
		/**
		* Allows for using soundboard in a voice channel
		*
		* Applies to channel types: Voice
		*/
		UseSoundboard: 1n << 42n,
		/**
		* Allows for creating emojis, stickers, and soundboard sounds, and editing and deleting those created by the current user
		*/
		CreateGuildExpressions: 1n << 43n,
		/**
		* Allows for creating scheduled events, and editing and deleting those created by the current user
		*
		* Applies to channel types: Voice, Stage
		*/
		CreateEvents: 1n << 44n,
		/**
		* Allows the usage of custom soundboard sounds from other servers
		*
		* Applies to channel types: Voice
		*/
		UseExternalSounds: 1n << 45n,
		/**
		* Allows sending voice messages
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		SendVoiceMessages: 1n << 46n,
		/**
		* Allows sending polls
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		SendPolls: 1n << 49n,
		/**
		* Allows user-installed apps to send public responses. When disabled, users will still be allowed to use their apps but the responses will be ephemeral. This only applies to apps not also installed to the server
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		UseExternalApps: 1n << 50n,
		/**
		* Allows pinning and unpinning messages
		*
		* Applies to channel types: Text
		*/
		PinMessages: 1n << 51n,
		/**
		* Allows bypassing slowmode restrictions
		*
		* Applies to channel types: Text, Voice, Stage
		*/
		BypassSlowmode: 1n << 52n
	};
	/**
	* Freeze the object of bits, preventing any modifications to it
	*
	* @internal
	*/
	Object.freeze(exports.PermissionFlagsBits);
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/application.js
var require_application = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/resources/application
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ApplicationWebhookEventStatus = exports.ActivityLocationKind = exports.ApplicationRoleConnectionMetadataType = exports.ApplicationFlags = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/application#application-object-application-flags}
	*/
	var ApplicationFlags;
	(function(ApplicationFlags) {
		/**
		* @unstable This application flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ApplicationFlags[ApplicationFlags["EmbeddedReleased"] = 2] = "EmbeddedReleased";
		/**
		* @unstable This application flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ApplicationFlags[ApplicationFlags["ManagedEmoji"] = 4] = "ManagedEmoji";
		/**
		* @unstable This application flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ApplicationFlags[ApplicationFlags["EmbeddedIAP"] = 8] = "EmbeddedIAP";
		/**
		* @unstable This application flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ApplicationFlags[ApplicationFlags["GroupDMCreate"] = 16] = "GroupDMCreate";
		/**
		* Indicates if an app uses the Auto Moderation API
		*/
		ApplicationFlags[ApplicationFlags["ApplicationAutoModerationRuleCreateBadge"] = 64] = "ApplicationAutoModerationRuleCreateBadge";
		/**
		* @unstable This application flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ApplicationFlags[ApplicationFlags["RPCHasConnected"] = 2048] = "RPCHasConnected";
		/**
		* Intent required for bots in 100 or more servers to receive `presence_update` events
		*/
		ApplicationFlags[ApplicationFlags["GatewayPresence"] = 4096] = "GatewayPresence";
		/**
		* Intent required for bots in under 100 servers to receive `presence_update` events, found in Bot Settings
		*/
		ApplicationFlags[ApplicationFlags["GatewayPresenceLimited"] = 8192] = "GatewayPresenceLimited";
		/**
		* Intent required for bots in 100 or more servers to receive member-related events like `guild_member_add`.
		*
		* @see List of member-related events {@link https://discord.com/developers/docs/topics/gateway#list-of-intents | under `GUILD_MEMBERS`}
		*/
		ApplicationFlags[ApplicationFlags["GatewayGuildMembers"] = 16384] = "GatewayGuildMembers";
		/**
		* Intent required for bots in under 100 servers to receive member-related events like `guild_member_add`, found in Bot Settings.
		*
		* @see List of member-related events {@link https://discord.com/developers/docs/topics/gateway#list-of-intents | under `GUILD_MEMBERS`}
		*/
		ApplicationFlags[ApplicationFlags["GatewayGuildMembersLimited"] = 32768] = "GatewayGuildMembersLimited";
		/**
		* Indicates unusual growth of an app that prevents verification
		*/
		ApplicationFlags[ApplicationFlags["VerificationPendingGuildLimit"] = 65536] = "VerificationPendingGuildLimit";
		/**
		* Indicates if an app is embedded within the Discord client (currently unavailable publicly)
		*/
		ApplicationFlags[ApplicationFlags["Embedded"] = 131072] = "Embedded";
		/**
		* Intent required for bots in 100 or more servers to receive {@link https://support-dev.discord.com/hc/articles/6207308062871 | message content}
		*/
		ApplicationFlags[ApplicationFlags["GatewayMessageContent"] = 262144] = "GatewayMessageContent";
		/**
		* Intent required for bots in under 100 servers to receive {@link https://support-dev.discord.com/hc/articles/6207308062871 | message content},
		* found in Bot Settings
		*/
		ApplicationFlags[ApplicationFlags["GatewayMessageContentLimited"] = 524288] = "GatewayMessageContentLimited";
		/**
		* @unstable This application flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ApplicationFlags[ApplicationFlags["EmbeddedFirstParty"] = 1048576] = "EmbeddedFirstParty";
		/**
		* Indicates if an app has registered global {@link https://discord.com/developers/docs/interactions/application-commands | application commands}
		*/
		ApplicationFlags[ApplicationFlags["ApplicationCommandBadge"] = 8388608] = "ApplicationCommandBadge";
	})(ApplicationFlags || (exports.ApplicationFlags = ApplicationFlags = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/application-role-connection-metadata#application-role-connection-metadata-object-application-role-connection-metadata-type}
	*/
	var ApplicationRoleConnectionMetadataType;
	(function(ApplicationRoleConnectionMetadataType) {
		/**
		* The metadata value (`integer`) is less than or equal to the guild's configured value (`integer`)
		*/
		ApplicationRoleConnectionMetadataType[ApplicationRoleConnectionMetadataType["IntegerLessThanOrEqual"] = 1] = "IntegerLessThanOrEqual";
		/**
		* The metadata value (`integer`) is greater than or equal to the guild's configured value (`integer`)
		*/
		ApplicationRoleConnectionMetadataType[ApplicationRoleConnectionMetadataType["IntegerGreaterThanOrEqual"] = 2] = "IntegerGreaterThanOrEqual";
		/**
		* The metadata value (`integer`) is equal to the guild's configured value (`integer`)
		*/
		ApplicationRoleConnectionMetadataType[ApplicationRoleConnectionMetadataType["IntegerEqual"] = 3] = "IntegerEqual";
		/**
		* The metadata value (`integer`) is not equal to the guild's configured value (`integer`)
		*/
		ApplicationRoleConnectionMetadataType[ApplicationRoleConnectionMetadataType["IntegerNotEqual"] = 4] = "IntegerNotEqual";
		/**
		* The metadata value (`ISO8601 string`) is less than or equal to the guild's configured value (`integer`; days before current date)
		*/
		ApplicationRoleConnectionMetadataType[ApplicationRoleConnectionMetadataType["DatetimeLessThanOrEqual"] = 5] = "DatetimeLessThanOrEqual";
		/**
		* The metadata value (`ISO8601 string`) is greater than or equal to the guild's configured value (`integer`; days before current date)
		*/
		ApplicationRoleConnectionMetadataType[ApplicationRoleConnectionMetadataType["DatetimeGreaterThanOrEqual"] = 6] = "DatetimeGreaterThanOrEqual";
		/**
		* The metadata value (`integer`) is equal to the guild's configured value (`integer`; `1`)
		*/
		ApplicationRoleConnectionMetadataType[ApplicationRoleConnectionMetadataType["BooleanEqual"] = 7] = "BooleanEqual";
		/**
		* The metadata value (`integer`) is not equal to the guild's configured value (`integer`; `1`)
		*/
		ApplicationRoleConnectionMetadataType[ApplicationRoleConnectionMetadataType["BooleanNotEqual"] = 8] = "BooleanNotEqual";
	})(ApplicationRoleConnectionMetadataType || (exports.ApplicationRoleConnectionMetadataType = ApplicationRoleConnectionMetadataType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/application#get-application-activity-instance-activity-location-kind-enum}
	*/
	var ActivityLocationKind;
	(function(ActivityLocationKind) {
		/**
		* Location is a guild channel
		*/
		ActivityLocationKind["GuildChannel"] = "gc";
		/**
		* Location is a private channel, such as a DM or GDM
		*/
		ActivityLocationKind["PrivateChannel"] = "pc";
	})(ActivityLocationKind || (exports.ActivityLocationKind = ActivityLocationKind = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/application#application-object-application-event-webhook-status}
	*/
	var ApplicationWebhookEventStatus;
	(function(ApplicationWebhookEventStatus) {
		/**
		* Webhook events are disabled by developer
		*/
		ApplicationWebhookEventStatus[ApplicationWebhookEventStatus["Disabled"] = 1] = "Disabled";
		/**
		* Webhook events are enabled by developer
		*/
		ApplicationWebhookEventStatus[ApplicationWebhookEventStatus["Enabled"] = 2] = "Enabled";
		/**
		* Webhook events are disabled by Discord, usually due to inactivity
		*/
		ApplicationWebhookEventStatus[ApplicationWebhookEventStatus["DisabledByDiscord"] = 3] = "DisabledByDiscord";
	})(ApplicationWebhookEventStatus || (exports.ApplicationWebhookEventStatus = ApplicationWebhookEventStatus = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/auditLog.js
var require_auditLog = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/resources/audit-log
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.AuditLogOptionsType = exports.AuditLogEvent = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events}
	*/
	var AuditLogEvent;
	(function(AuditLogEvent) {
		AuditLogEvent[AuditLogEvent["GuildUpdate"] = 1] = "GuildUpdate";
		AuditLogEvent[AuditLogEvent["ChannelCreate"] = 10] = "ChannelCreate";
		AuditLogEvent[AuditLogEvent["ChannelUpdate"] = 11] = "ChannelUpdate";
		AuditLogEvent[AuditLogEvent["ChannelDelete"] = 12] = "ChannelDelete";
		AuditLogEvent[AuditLogEvent["ChannelOverwriteCreate"] = 13] = "ChannelOverwriteCreate";
		AuditLogEvent[AuditLogEvent["ChannelOverwriteUpdate"] = 14] = "ChannelOverwriteUpdate";
		AuditLogEvent[AuditLogEvent["ChannelOverwriteDelete"] = 15] = "ChannelOverwriteDelete";
		AuditLogEvent[AuditLogEvent["MemberKick"] = 20] = "MemberKick";
		AuditLogEvent[AuditLogEvent["MemberPrune"] = 21] = "MemberPrune";
		AuditLogEvent[AuditLogEvent["MemberBanAdd"] = 22] = "MemberBanAdd";
		AuditLogEvent[AuditLogEvent["MemberBanRemove"] = 23] = "MemberBanRemove";
		AuditLogEvent[AuditLogEvent["MemberUpdate"] = 24] = "MemberUpdate";
		AuditLogEvent[AuditLogEvent["MemberRoleUpdate"] = 25] = "MemberRoleUpdate";
		AuditLogEvent[AuditLogEvent["MemberMove"] = 26] = "MemberMove";
		AuditLogEvent[AuditLogEvent["MemberDisconnect"] = 27] = "MemberDisconnect";
		AuditLogEvent[AuditLogEvent["BotAdd"] = 28] = "BotAdd";
		AuditLogEvent[AuditLogEvent["RoleCreate"] = 30] = "RoleCreate";
		AuditLogEvent[AuditLogEvent["RoleUpdate"] = 31] = "RoleUpdate";
		AuditLogEvent[AuditLogEvent["RoleDelete"] = 32] = "RoleDelete";
		AuditLogEvent[AuditLogEvent["InviteCreate"] = 40] = "InviteCreate";
		AuditLogEvent[AuditLogEvent["InviteUpdate"] = 41] = "InviteUpdate";
		AuditLogEvent[AuditLogEvent["InviteDelete"] = 42] = "InviteDelete";
		AuditLogEvent[AuditLogEvent["WebhookCreate"] = 50] = "WebhookCreate";
		AuditLogEvent[AuditLogEvent["WebhookUpdate"] = 51] = "WebhookUpdate";
		AuditLogEvent[AuditLogEvent["WebhookDelete"] = 52] = "WebhookDelete";
		AuditLogEvent[AuditLogEvent["EmojiCreate"] = 60] = "EmojiCreate";
		AuditLogEvent[AuditLogEvent["EmojiUpdate"] = 61] = "EmojiUpdate";
		AuditLogEvent[AuditLogEvent["EmojiDelete"] = 62] = "EmojiDelete";
		AuditLogEvent[AuditLogEvent["MessageDelete"] = 72] = "MessageDelete";
		AuditLogEvent[AuditLogEvent["MessageBulkDelete"] = 73] = "MessageBulkDelete";
		AuditLogEvent[AuditLogEvent["MessagePin"] = 74] = "MessagePin";
		AuditLogEvent[AuditLogEvent["MessageUnpin"] = 75] = "MessageUnpin";
		AuditLogEvent[AuditLogEvent["IntegrationCreate"] = 80] = "IntegrationCreate";
		AuditLogEvent[AuditLogEvent["IntegrationUpdate"] = 81] = "IntegrationUpdate";
		AuditLogEvent[AuditLogEvent["IntegrationDelete"] = 82] = "IntegrationDelete";
		AuditLogEvent[AuditLogEvent["StageInstanceCreate"] = 83] = "StageInstanceCreate";
		AuditLogEvent[AuditLogEvent["StageInstanceUpdate"] = 84] = "StageInstanceUpdate";
		AuditLogEvent[AuditLogEvent["StageInstanceDelete"] = 85] = "StageInstanceDelete";
		AuditLogEvent[AuditLogEvent["StickerCreate"] = 90] = "StickerCreate";
		AuditLogEvent[AuditLogEvent["StickerUpdate"] = 91] = "StickerUpdate";
		AuditLogEvent[AuditLogEvent["StickerDelete"] = 92] = "StickerDelete";
		AuditLogEvent[AuditLogEvent["GuildScheduledEventCreate"] = 100] = "GuildScheduledEventCreate";
		AuditLogEvent[AuditLogEvent["GuildScheduledEventUpdate"] = 101] = "GuildScheduledEventUpdate";
		AuditLogEvent[AuditLogEvent["GuildScheduledEventDelete"] = 102] = "GuildScheduledEventDelete";
		AuditLogEvent[AuditLogEvent["ThreadCreate"] = 110] = "ThreadCreate";
		AuditLogEvent[AuditLogEvent["ThreadUpdate"] = 111] = "ThreadUpdate";
		AuditLogEvent[AuditLogEvent["ThreadDelete"] = 112] = "ThreadDelete";
		AuditLogEvent[AuditLogEvent["ApplicationCommandPermissionUpdate"] = 121] = "ApplicationCommandPermissionUpdate";
		AuditLogEvent[AuditLogEvent["SoundboardSoundCreate"] = 130] = "SoundboardSoundCreate";
		AuditLogEvent[AuditLogEvent["SoundboardSoundUpdate"] = 131] = "SoundboardSoundUpdate";
		AuditLogEvent[AuditLogEvent["SoundboardSoundDelete"] = 132] = "SoundboardSoundDelete";
		AuditLogEvent[AuditLogEvent["AutoModerationRuleCreate"] = 140] = "AutoModerationRuleCreate";
		AuditLogEvent[AuditLogEvent["AutoModerationRuleUpdate"] = 141] = "AutoModerationRuleUpdate";
		AuditLogEvent[AuditLogEvent["AutoModerationRuleDelete"] = 142] = "AutoModerationRuleDelete";
		AuditLogEvent[AuditLogEvent["AutoModerationBlockMessage"] = 143] = "AutoModerationBlockMessage";
		AuditLogEvent[AuditLogEvent["AutoModerationFlagToChannel"] = 144] = "AutoModerationFlagToChannel";
		AuditLogEvent[AuditLogEvent["AutoModerationUserCommunicationDisabled"] = 145] = "AutoModerationUserCommunicationDisabled";
		AuditLogEvent[AuditLogEvent["AutoModerationQuarantineUser"] = 146] = "AutoModerationQuarantineUser";
		AuditLogEvent[AuditLogEvent["CreatorMonetizationRequestCreated"] = 150] = "CreatorMonetizationRequestCreated";
		AuditLogEvent[AuditLogEvent["CreatorMonetizationTermsAccepted"] = 151] = "CreatorMonetizationTermsAccepted";
		AuditLogEvent[AuditLogEvent["OnboardingPromptCreate"] = 163] = "OnboardingPromptCreate";
		AuditLogEvent[AuditLogEvent["OnboardingPromptUpdate"] = 164] = "OnboardingPromptUpdate";
		AuditLogEvent[AuditLogEvent["OnboardingPromptDelete"] = 165] = "OnboardingPromptDelete";
		AuditLogEvent[AuditLogEvent["OnboardingCreate"] = 166] = "OnboardingCreate";
		AuditLogEvent[AuditLogEvent["OnboardingUpdate"] = 167] = "OnboardingUpdate";
		AuditLogEvent[AuditLogEvent["HomeSettingsCreate"] = 190] = "HomeSettingsCreate";
		AuditLogEvent[AuditLogEvent["HomeSettingsUpdate"] = 191] = "HomeSettingsUpdate";
	})(AuditLogEvent || (exports.AuditLogEvent = AuditLogEvent = {}));
	var AuditLogOptionsType;
	(function(AuditLogOptionsType) {
		AuditLogOptionsType["Role"] = "0";
		AuditLogOptionsType["Member"] = "1";
	})(AuditLogOptionsType || (exports.AuditLogOptionsType = AuditLogOptionsType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/autoModeration.js
var require_autoModeration = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/resources/auto-moderation
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.AutoModerationActionType = exports.AutoModerationRuleEventType = exports.AutoModerationRuleKeywordPresetType = exports.AutoModerationRuleTriggerType = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-trigger-types}
	*/
	var AutoModerationRuleTriggerType;
	(function(AutoModerationRuleTriggerType) {
		/**
		* Check if content contains words from a user defined list of keywords (Maximum of 6 per guild)
		*/
		AutoModerationRuleTriggerType[AutoModerationRuleTriggerType["Keyword"] = 1] = "Keyword";
		/**
		* Check if content represents generic spam (Maximum of 1 per guild)
		*/
		AutoModerationRuleTriggerType[AutoModerationRuleTriggerType["Spam"] = 3] = "Spam";
		/**
		* Check if content contains words from internal pre-defined wordsets (Maximum of 1 per guild)
		*/
		AutoModerationRuleTriggerType[AutoModerationRuleTriggerType["KeywordPreset"] = 4] = "KeywordPreset";
		/**
		* Check if content contains more mentions than allowed (Maximum of 1 per guild)
		*/
		AutoModerationRuleTriggerType[AutoModerationRuleTriggerType["MentionSpam"] = 5] = "MentionSpam";
		/**
		* Check if member profile contains words from a user defined list of keywords (Maximum of 1 per guild)
		*/
		AutoModerationRuleTriggerType[AutoModerationRuleTriggerType["MemberProfile"] = 6] = "MemberProfile";
	})(AutoModerationRuleTriggerType || (exports.AutoModerationRuleTriggerType = AutoModerationRuleTriggerType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-keyword-preset-types}
	*/
	var AutoModerationRuleKeywordPresetType;
	(function(AutoModerationRuleKeywordPresetType) {
		/**
		* Words that may be considered forms of swearing or cursing
		*/
		AutoModerationRuleKeywordPresetType[AutoModerationRuleKeywordPresetType["Profanity"] = 1] = "Profanity";
		/**
		* Words that refer to sexually explicit behavior or activity
		*/
		AutoModerationRuleKeywordPresetType[AutoModerationRuleKeywordPresetType["SexualContent"] = 2] = "SexualContent";
		/**
		* Personal insults or words that may be considered hate speech
		*/
		AutoModerationRuleKeywordPresetType[AutoModerationRuleKeywordPresetType["Slurs"] = 3] = "Slurs";
	})(AutoModerationRuleKeywordPresetType || (exports.AutoModerationRuleKeywordPresetType = AutoModerationRuleKeywordPresetType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-event-types}
	*/
	var AutoModerationRuleEventType;
	(function(AutoModerationRuleEventType) {
		/**
		* When a member sends or edits a message in the guild
		*/
		AutoModerationRuleEventType[AutoModerationRuleEventType["MessageSend"] = 1] = "MessageSend";
		/**
		* When a member edits their profile
		*/
		AutoModerationRuleEventType[AutoModerationRuleEventType["MemberUpdate"] = 2] = "MemberUpdate";
	})(AutoModerationRuleEventType || (exports.AutoModerationRuleEventType = AutoModerationRuleEventType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-action-object-action-types}
	*/
	var AutoModerationActionType;
	(function(AutoModerationActionType) {
		/**
		* Blocks a member's message and prevents it from being posted.
		* A custom explanation can be specified and shown to members whenever their message is blocked
		*/
		AutoModerationActionType[AutoModerationActionType["BlockMessage"] = 1] = "BlockMessage";
		/**
		* Logs user content to a specified channel
		*/
		AutoModerationActionType[AutoModerationActionType["SendAlertMessage"] = 2] = "SendAlertMessage";
		/**
		* Timeout user for specified duration, this action type can be set if the bot has `MODERATE_MEMBERS` permission
		*/
		AutoModerationActionType[AutoModerationActionType["Timeout"] = 3] = "Timeout";
		/**
		* Prevents a member from using text, voice, or other interactions
		*/
		AutoModerationActionType[AutoModerationActionType["BlockMemberInteraction"] = 4] = "BlockMemberInteraction";
	})(AutoModerationActionType || (exports.AutoModerationActionType = AutoModerationActionType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/channel.js
var require_channel$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/resources/channel
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ChannelFlags = exports.ThreadMemberFlags = exports.ThreadAutoArchiveDuration = exports.OverwriteType = exports.VideoQualityMode = exports.ChannelType = exports.ForumLayoutType = exports.SortOrderType = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/channel/#channel-object-sort-order-types}
	*/
	var SortOrderType;
	(function(SortOrderType) {
		/**
		* Sort forum posts by activity
		*/
		SortOrderType[SortOrderType["LatestActivity"] = 0] = "LatestActivity";
		/**
		* Sort forum posts by creation time (from most recent to oldest)
		*/
		SortOrderType[SortOrderType["CreationDate"] = 1] = "CreationDate";
	})(SortOrderType || (exports.SortOrderType = SortOrderType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/channel/#channel-object-forum-layout-types}
	*/
	var ForumLayoutType;
	(function(ForumLayoutType) {
		/**
		* No default has been set for forum channel
		*/
		ForumLayoutType[ForumLayoutType["NotSet"] = 0] = "NotSet";
		/**
		* Display posts as a list
		*/
		ForumLayoutType[ForumLayoutType["ListView"] = 1] = "ListView";
		/**
		* Display posts as a collection of tiles
		*/
		ForumLayoutType[ForumLayoutType["GalleryView"] = 2] = "GalleryView";
	})(ForumLayoutType || (exports.ForumLayoutType = ForumLayoutType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/channel#channel-object-channel-types}
	*/
	var ChannelType;
	(function(ChannelType) {
		/**
		* A text channel within a guild
		*/
		ChannelType[ChannelType["GuildText"] = 0] = "GuildText";
		/**
		* A direct message between users
		*/
		ChannelType[ChannelType["DM"] = 1] = "DM";
		/**
		* A voice channel within a guild
		*/
		ChannelType[ChannelType["GuildVoice"] = 2] = "GuildVoice";
		/**
		* A direct message between multiple users
		*/
		ChannelType[ChannelType["GroupDM"] = 3] = "GroupDM";
		/**
		* An organizational category that contains up to 50 channels
		*
		* @see {@link https://support.discord.com/hc/articles/115001580171}
		*/
		ChannelType[ChannelType["GuildCategory"] = 4] = "GuildCategory";
		/**
		* A channel that users can follow and crosspost into their own guild
		*
		* @see {@link https://support.discord.com/hc/articles/360032008192}
		*/
		ChannelType[ChannelType["GuildAnnouncement"] = 5] = "GuildAnnouncement";
		/**
		* A temporary sub-channel within a Guild Announcement channel
		*/
		ChannelType[ChannelType["AnnouncementThread"] = 10] = "AnnouncementThread";
		/**
		* A temporary sub-channel within a Guild Text or Guild Forum channel
		*/
		ChannelType[ChannelType["PublicThread"] = 11] = "PublicThread";
		/**
		* A temporary sub-channel within a Guild Text channel that is only viewable by those invited and those with the Manage Threads permission
		*/
		ChannelType[ChannelType["PrivateThread"] = 12] = "PrivateThread";
		/**
		* A voice channel for hosting events with an audience
		*
		* @see {@link https://support.discord.com/hc/articles/1500005513722}
		*/
		ChannelType[ChannelType["GuildStageVoice"] = 13] = "GuildStageVoice";
		/**
		* The channel in a Student Hub containing the listed servers
		*
		* @see {@link https://support.discord.com/hc/articles/4406046651927}
		*/
		ChannelType[ChannelType["GuildDirectory"] = 14] = "GuildDirectory";
		/**
		* A channel that can only contain threads
		*/
		ChannelType[ChannelType["GuildForum"] = 15] = "GuildForum";
		/**
		* A channel like forum channels but contains media for server subscriptions
		*
		* @see {@link https://creator-support.discord.com/hc/articles/14346342766743}
		*/
		ChannelType[ChannelType["GuildMedia"] = 16] = "GuildMedia";
		/**
		* A channel that users can follow and crosspost into their own guild
		*
		* @deprecated This is the old name for {@link ChannelType.GuildAnnouncement}
		* @see {@link https://support.discord.com/hc/articles/360032008192}
		*/
		ChannelType[ChannelType["GuildNews"] = 5] = "GuildNews";
		/**
		* A temporary sub-channel within a Guild Announcement channel
		*
		* @deprecated This is the old name for {@link ChannelType.AnnouncementThread}
		*/
		ChannelType[ChannelType["GuildNewsThread"] = 10] = "GuildNewsThread";
		/**
		* A temporary sub-channel within a Guild Text channel
		*
		* @deprecated This is the old name for {@link ChannelType.PublicThread}
		*/
		ChannelType[ChannelType["GuildPublicThread"] = 11] = "GuildPublicThread";
		/**
		* A temporary sub-channel within a Guild Text channel that is only viewable by those invited and those with the Manage Threads permission
		*
		* @deprecated This is the old name for {@link ChannelType.PrivateThread}
		*/
		ChannelType[ChannelType["GuildPrivateThread"] = 12] = "GuildPrivateThread";
	})(ChannelType || (exports.ChannelType = ChannelType = {}));
	var VideoQualityMode;
	(function(VideoQualityMode) {
		/**
		* Discord chooses the quality for optimal performance
		*/
		VideoQualityMode[VideoQualityMode["Auto"] = 1] = "Auto";
		/**
		* 720p
		*/
		VideoQualityMode[VideoQualityMode["Full"] = 2] = "Full";
	})(VideoQualityMode || (exports.VideoQualityMode = VideoQualityMode = {}));
	var OverwriteType;
	(function(OverwriteType) {
		OverwriteType[OverwriteType["Role"] = 0] = "Role";
		OverwriteType[OverwriteType["Member"] = 1] = "Member";
	})(OverwriteType || (exports.OverwriteType = OverwriteType = {}));
	var ThreadAutoArchiveDuration;
	(function(ThreadAutoArchiveDuration) {
		ThreadAutoArchiveDuration[ThreadAutoArchiveDuration["OneHour"] = 60] = "OneHour";
		ThreadAutoArchiveDuration[ThreadAutoArchiveDuration["OneDay"] = 1440] = "OneDay";
		ThreadAutoArchiveDuration[ThreadAutoArchiveDuration["ThreeDays"] = 4320] = "ThreeDays";
		ThreadAutoArchiveDuration[ThreadAutoArchiveDuration["OneWeek"] = 10080] = "OneWeek";
	})(ThreadAutoArchiveDuration || (exports.ThreadAutoArchiveDuration = ThreadAutoArchiveDuration = {}));
	var ThreadMemberFlags;
	(function(ThreadMemberFlags) {
		/**
		* @unstable This thread member flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ThreadMemberFlags[ThreadMemberFlags["HasInteracted"] = 1] = "HasInteracted";
		/**
		* @unstable This thread member flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ThreadMemberFlags[ThreadMemberFlags["AllMessages"] = 2] = "AllMessages";
		/**
		* @unstable This thread member flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ThreadMemberFlags[ThreadMemberFlags["OnlyMentions"] = 4] = "OnlyMentions";
		/**
		* @unstable This thread member flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ThreadMemberFlags[ThreadMemberFlags["NoMessages"] = 8] = "NoMessages";
	})(ThreadMemberFlags || (exports.ThreadMemberFlags = ThreadMemberFlags = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/channel#channel-object-channel-flags}
	*/
	var ChannelFlags;
	(function(ChannelFlags) {
		/**
		* @unstable This channel flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ChannelFlags[ChannelFlags["GuildFeedRemoved"] = 1] = "GuildFeedRemoved";
		/**
		* This thread is pinned to the top of its parent forum channel
		*/
		ChannelFlags[ChannelFlags["Pinned"] = 2] = "Pinned";
		/**
		* @unstable This channel flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ChannelFlags[ChannelFlags["ActiveChannelsRemoved"] = 4] = "ActiveChannelsRemoved";
		/**
		* Whether a tag is required to be specified when creating a thread in a forum channel.
		* Tags are specified in the `applied_tags` field
		*/
		ChannelFlags[ChannelFlags["RequireTag"] = 16] = "RequireTag";
		/**
		* @unstable This channel flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ChannelFlags[ChannelFlags["IsSpam"] = 32] = "IsSpam";
		/**
		* @unstable This channel flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ChannelFlags[ChannelFlags["IsGuildResourceChannel"] = 128] = "IsGuildResourceChannel";
		/**
		* @unstable This channel flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ChannelFlags[ChannelFlags["ClydeAI"] = 256] = "ClydeAI";
		/**
		* @unstable This channel flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ChannelFlags[ChannelFlags["IsScheduledForDeletion"] = 512] = "IsScheduledForDeletion";
		/**
		* Whether media download options are hidden.
		*/
		ChannelFlags[ChannelFlags["HideMediaDownloadOptions"] = 32768] = "HideMediaDownloadOptions";
	})(ChannelFlags || (exports.ChannelFlags = ChannelFlags = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/gateway.js
var require_gateway = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from
	*  - https://discord.com/developers/docs/topics/gateway
	*  - https://discord.com/developers/docs/topics/gateway-events
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ActivityFlags = exports.StatusDisplayType = exports.ActivityType = exports.ActivityPlatform = exports.PresenceUpdateStatus = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/topics/gateway-events#update-presence-status-types}
	*/
	var PresenceUpdateStatus;
	(function(PresenceUpdateStatus) {
		PresenceUpdateStatus["Online"] = "online";
		PresenceUpdateStatus["DoNotDisturb"] = "dnd";
		PresenceUpdateStatus["Idle"] = "idle";
		/**
		* Invisible and shown as offline
		*/
		PresenceUpdateStatus["Invisible"] = "invisible";
		PresenceUpdateStatus["Offline"] = "offline";
	})(PresenceUpdateStatus || (exports.PresenceUpdateStatus = PresenceUpdateStatus = {}));
	/**
	* @unstable This enum is currently not documented by Discord but has known values which we will try to keep up to date.
	* Values might be added or removed without a major version bump.
	*/
	var ActivityPlatform;
	(function(ActivityPlatform) {
		ActivityPlatform["Desktop"] = "desktop";
		ActivityPlatform["Xbox"] = "xbox";
		ActivityPlatform["Samsung"] = "samsung";
		ActivityPlatform["IOS"] = "ios";
		ActivityPlatform["Android"] = "android";
		ActivityPlatform["Embedded"] = "embedded";
		ActivityPlatform["PS4"] = "ps4";
		ActivityPlatform["PS5"] = "ps5";
	})(ActivityPlatform || (exports.ActivityPlatform = ActivityPlatform = {}));
	/**
	* @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-types}
	*/
	var ActivityType;
	(function(ActivityType) {
		/**
		* Playing \{game\}
		*/
		ActivityType[ActivityType["Playing"] = 0] = "Playing";
		/**
		* Streaming \{details\}
		*/
		ActivityType[ActivityType["Streaming"] = 1] = "Streaming";
		/**
		* Listening to \{name\}
		*/
		ActivityType[ActivityType["Listening"] = 2] = "Listening";
		/**
		* Watching \{details\}
		*/
		ActivityType[ActivityType["Watching"] = 3] = "Watching";
		/**
		* \{emoji\} \{state\}
		*/
		ActivityType[ActivityType["Custom"] = 4] = "Custom";
		/**
		* Competing in \{name\}
		*/
		ActivityType[ActivityType["Competing"] = 5] = "Competing";
	})(ActivityType || (exports.ActivityType = ActivityType = {}));
	/**
	* Controls which field is used in the user's status message
	*
	* @see {@link https://discord.com/developers/docs/events/gateway-events#activity-object-status-display-types}
	*/
	var StatusDisplayType;
	(function(StatusDisplayType) {
		/**
		* Playing \{name\}
		*/
		StatusDisplayType[StatusDisplayType["Name"] = 0] = "Name";
		/**
		* Playing \{state\}
		*/
		StatusDisplayType[StatusDisplayType["State"] = 1] = "State";
		/**
		* Playing \{details\}
		*/
		StatusDisplayType[StatusDisplayType["Details"] = 2] = "Details";
	})(StatusDisplayType || (exports.StatusDisplayType = StatusDisplayType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-flags}
	*/
	var ActivityFlags;
	(function(ActivityFlags) {
		ActivityFlags[ActivityFlags["Instance"] = 1] = "Instance";
		ActivityFlags[ActivityFlags["Join"] = 2] = "Join";
		ActivityFlags[ActivityFlags["Spectate"] = 4] = "Spectate";
		ActivityFlags[ActivityFlags["JoinRequest"] = 8] = "JoinRequest";
		ActivityFlags[ActivityFlags["Sync"] = 16] = "Sync";
		ActivityFlags[ActivityFlags["Play"] = 32] = "Play";
		ActivityFlags[ActivityFlags["PartyPrivacyFriends"] = 64] = "PartyPrivacyFriends";
		ActivityFlags[ActivityFlags["PartyPrivacyVoiceChannel"] = 128] = "PartyPrivacyVoiceChannel";
		ActivityFlags[ActivityFlags["Embedded"] = 256] = "Embedded";
	})(ActivityFlags || (exports.ActivityFlags = ActivityFlags = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/guild.js
var require_guild = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/resources/guild
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.GuildOnboardingPromptType = exports.GuildOnboardingMode = exports.MembershipScreeningFieldType = exports.GuildWidgetStyle = exports.IntegrationExpireBehavior = exports.GuildMemberFlags = exports.GuildFeature = exports.GuildSystemChannelFlags = exports.GuildHubType = exports.GuildPremiumTier = exports.GuildVerificationLevel = exports.GuildNSFWLevel = exports.GuildMFALevel = exports.GuildExplicitContentFilter = exports.GuildDefaultMessageNotifications = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#guild-object-default-message-notification-level}
	*/
	var GuildDefaultMessageNotifications;
	(function(GuildDefaultMessageNotifications) {
		GuildDefaultMessageNotifications[GuildDefaultMessageNotifications["AllMessages"] = 0] = "AllMessages";
		GuildDefaultMessageNotifications[GuildDefaultMessageNotifications["OnlyMentions"] = 1] = "OnlyMentions";
	})(GuildDefaultMessageNotifications || (exports.GuildDefaultMessageNotifications = GuildDefaultMessageNotifications = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#guild-object-explicit-content-filter-level}
	*/
	var GuildExplicitContentFilter;
	(function(GuildExplicitContentFilter) {
		GuildExplicitContentFilter[GuildExplicitContentFilter["Disabled"] = 0] = "Disabled";
		GuildExplicitContentFilter[GuildExplicitContentFilter["MembersWithoutRoles"] = 1] = "MembersWithoutRoles";
		GuildExplicitContentFilter[GuildExplicitContentFilter["AllMembers"] = 2] = "AllMembers";
	})(GuildExplicitContentFilter || (exports.GuildExplicitContentFilter = GuildExplicitContentFilter = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#guild-object-mfa-level}
	*/
	var GuildMFALevel;
	(function(GuildMFALevel) {
		GuildMFALevel[GuildMFALevel["None"] = 0] = "None";
		GuildMFALevel[GuildMFALevel["Elevated"] = 1] = "Elevated";
	})(GuildMFALevel || (exports.GuildMFALevel = GuildMFALevel = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#guild-object-guild-nsfw-level}
	*/
	var GuildNSFWLevel;
	(function(GuildNSFWLevel) {
		GuildNSFWLevel[GuildNSFWLevel["Default"] = 0] = "Default";
		GuildNSFWLevel[GuildNSFWLevel["Explicit"] = 1] = "Explicit";
		GuildNSFWLevel[GuildNSFWLevel["Safe"] = 2] = "Safe";
		GuildNSFWLevel[GuildNSFWLevel["AgeRestricted"] = 3] = "AgeRestricted";
	})(GuildNSFWLevel || (exports.GuildNSFWLevel = GuildNSFWLevel = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#guild-object-verification-level}
	*/
	var GuildVerificationLevel;
	(function(GuildVerificationLevel) {
		/**
		* Unrestricted
		*/
		GuildVerificationLevel[GuildVerificationLevel["None"] = 0] = "None";
		/**
		* Must have verified email on account
		*/
		GuildVerificationLevel[GuildVerificationLevel["Low"] = 1] = "Low";
		/**
		* Must be registered on Discord for longer than 5 minutes
		*/
		GuildVerificationLevel[GuildVerificationLevel["Medium"] = 2] = "Medium";
		/**
		* Must be a member of the guild for longer than 10 minutes
		*/
		GuildVerificationLevel[GuildVerificationLevel["High"] = 3] = "High";
		/**
		* Must have a verified phone number
		*/
		GuildVerificationLevel[GuildVerificationLevel["VeryHigh"] = 4] = "VeryHigh";
	})(GuildVerificationLevel || (exports.GuildVerificationLevel = GuildVerificationLevel = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#guild-object-premium-tier}
	*/
	var GuildPremiumTier;
	(function(GuildPremiumTier) {
		GuildPremiumTier[GuildPremiumTier["None"] = 0] = "None";
		GuildPremiumTier[GuildPremiumTier["Tier1"] = 1] = "Tier1";
		GuildPremiumTier[GuildPremiumTier["Tier2"] = 2] = "Tier2";
		GuildPremiumTier[GuildPremiumTier["Tier3"] = 3] = "Tier3";
	})(GuildPremiumTier || (exports.GuildPremiumTier = GuildPremiumTier = {}));
	var GuildHubType;
	(function(GuildHubType) {
		GuildHubType[GuildHubType["Default"] = 0] = "Default";
		GuildHubType[GuildHubType["HighSchool"] = 1] = "HighSchool";
		GuildHubType[GuildHubType["College"] = 2] = "College";
	})(GuildHubType || (exports.GuildHubType = GuildHubType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#guild-object-system-channel-flags}
	*/
	var GuildSystemChannelFlags;
	(function(GuildSystemChannelFlags) {
		/**
		* Suppress member join notifications
		*/
		GuildSystemChannelFlags[GuildSystemChannelFlags["SuppressJoinNotifications"] = 1] = "SuppressJoinNotifications";
		/**
		* Suppress server boost notifications
		*/
		GuildSystemChannelFlags[GuildSystemChannelFlags["SuppressPremiumSubscriptions"] = 2] = "SuppressPremiumSubscriptions";
		/**
		* Suppress server setup tips
		*/
		GuildSystemChannelFlags[GuildSystemChannelFlags["SuppressGuildReminderNotifications"] = 4] = "SuppressGuildReminderNotifications";
		/**
		* Hide member join sticker reply buttons
		*/
		GuildSystemChannelFlags[GuildSystemChannelFlags["SuppressJoinNotificationReplies"] = 8] = "SuppressJoinNotificationReplies";
		/**
		* Suppress role subscription purchase and renewal notifications
		*/
		GuildSystemChannelFlags[GuildSystemChannelFlags["SuppressRoleSubscriptionPurchaseNotifications"] = 16] = "SuppressRoleSubscriptionPurchaseNotifications";
		/**
		* Hide role subscription sticker reply buttons
		*/
		GuildSystemChannelFlags[GuildSystemChannelFlags["SuppressRoleSubscriptionPurchaseNotificationReplies"] = 32] = "SuppressRoleSubscriptionPurchaseNotificationReplies";
	})(GuildSystemChannelFlags || (exports.GuildSystemChannelFlags = GuildSystemChannelFlags = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#guild-object-guild-features}
	*/
	var GuildFeature;
	(function(GuildFeature) {
		/**
		* Guild has access to set an animated guild banner image
		*/
		GuildFeature["AnimatedBanner"] = "ANIMATED_BANNER";
		/**
		* Guild has access to set an animated guild icon
		*/
		GuildFeature["AnimatedIcon"] = "ANIMATED_ICON";
		/**
		* Guild is using the old permissions configuration behavior
		*
		* @see {@link https://discord.com/developers/docs/change-log#upcoming-application-command-permission-changes}
		*/
		GuildFeature["ApplicationCommandPermissionsV2"] = "APPLICATION_COMMAND_PERMISSIONS_V2";
		/**
		* Guild has set up auto moderation rules
		*/
		GuildFeature["AutoModeration"] = "AUTO_MODERATION";
		/**
		* Guild has access to set a guild banner image
		*/
		GuildFeature["Banner"] = "BANNER";
		/**
		* Guild can enable welcome screen, Membership Screening and discovery, and receives community updates
		*/
		GuildFeature["Community"] = "COMMUNITY";
		/**
		* Guild has enabled monetization
		*/
		GuildFeature["CreatorMonetizableProvisional"] = "CREATOR_MONETIZABLE_PROVISIONAL";
		/**
		* Guild has enabled the role subscription promo page
		*/
		GuildFeature["CreatorStorePage"] = "CREATOR_STORE_PAGE";
		/**
		* Guild has been set as a support server on the App Directory
		*/
		GuildFeature["DeveloperSupportServer"] = "DEVELOPER_SUPPORT_SERVER";
		/**
		* Guild is able to be discovered in the directory
		*/
		GuildFeature["Discoverable"] = "DISCOVERABLE";
		/**
		* Guild is able to be featured in the directory
		*/
		GuildFeature["Featurable"] = "FEATURABLE";
		/**
		* Guild is listed in a directory channel
		*/
		GuildFeature["HasDirectoryEntry"] = "HAS_DIRECTORY_ENTRY";
		/**
		* Guild is a Student Hub
		*
		* @see {@link https://support.discord.com/hc/articles/4406046651927}
		* @unstable This feature is currently not documented by Discord, but has known value
		*/
		GuildFeature["Hub"] = "HUB";
		/**
		* Guild has disabled invite usage, preventing users from joining
		*/
		GuildFeature["InvitesDisabled"] = "INVITES_DISABLED";
		/**
		* Guild has access to set an invite splash background
		*/
		GuildFeature["InviteSplash"] = "INVITE_SPLASH";
		/**
		* Guild is in a Student Hub
		*
		* @see {@link https://support.discord.com/hc/articles/4406046651927}
		* @unstable This feature is currently not documented by Discord, but has known value
		*/
		GuildFeature["LinkedToHub"] = "LINKED_TO_HUB";
		/**
		* Guild has enabled Membership Screening
		*/
		GuildFeature["MemberVerificationGateEnabled"] = "MEMBER_VERIFICATION_GATE_ENABLED";
		/**
		* Guild has increased custom soundboard sound slots
		*/
		GuildFeature["MoreSoundboard"] = "MORE_SOUNDBOARD";
		/**
		* Guild has enabled monetization
		*
		* @unstable This feature is no longer documented by Discord
		*/
		GuildFeature["MonetizationEnabled"] = "MONETIZATION_ENABLED";
		/**
		* Guild has increased custom sticker slots
		*/
		GuildFeature["MoreStickers"] = "MORE_STICKERS";
		/**
		* Guild has access to create news channels
		*/
		GuildFeature["News"] = "NEWS";
		/**
		* Guild is partnered
		*/
		GuildFeature["Partnered"] = "PARTNERED";
		/**
		* Guild can be previewed before joining via Membership Screening or the directory
		*/
		GuildFeature["PreviewEnabled"] = "PREVIEW_ENABLED";
		/**
		* Guild has access to create private threads
		*/
		GuildFeature["PrivateThreads"] = "PRIVATE_THREADS";
		/**
		* Guild has disabled alerts for join raids in the configured safety alerts channel
		*/
		GuildFeature["RaidAlertsDisabled"] = "RAID_ALERTS_DISABLED";
		GuildFeature["RelayEnabled"] = "RELAY_ENABLED";
		/**
		* Guild is able to set role icons
		*/
		GuildFeature["RoleIcons"] = "ROLE_ICONS";
		/**
		* Guild has role subscriptions that can be purchased
		*/
		GuildFeature["RoleSubscriptionsAvailableForPurchase"] = "ROLE_SUBSCRIPTIONS_AVAILABLE_FOR_PURCHASE";
		/**
		* Guild has enabled role subscriptions
		*/
		GuildFeature["RoleSubscriptionsEnabled"] = "ROLE_SUBSCRIPTIONS_ENABLED";
		/**
		* Guild has created soundboard sounds
		*/
		GuildFeature["Soundboard"] = "SOUNDBOARD";
		/**
		* Guild has enabled ticketed events
		*/
		GuildFeature["TicketedEventsEnabled"] = "TICKETED_EVENTS_ENABLED";
		/**
		* Guild has access to set a vanity URL
		*/
		GuildFeature["VanityURL"] = "VANITY_URL";
		/**
		* Guild is verified
		*/
		GuildFeature["Verified"] = "VERIFIED";
		/**
		* Guild has access to set 384kbps bitrate in voice (previously VIP voice servers)
		*/
		GuildFeature["VIPRegions"] = "VIP_REGIONS";
		/**
		* Guild has enabled the welcome screen
		*/
		GuildFeature["WelcomeScreenEnabled"] = "WELCOME_SCREEN_ENABLED";
		/**
		* Guild has access to set guild tags
		*/
		GuildFeature["GuildTags"] = "GUILD_TAGS";
		/**
		* Guild is able to set gradient colors to roles
		*/
		GuildFeature["EnhancedRoleColors"] = "ENHANCED_ROLE_COLORS";
		/**
		* Guild has access to guest invites
		*/
		GuildFeature["GuestsEnabled"] = "GUESTS_ENABLED";
		/**
		* Guild has migrated to the new pin messages permission
		*
		* @unstable This feature is currently not documented by Discord, but has known value
		*/
		GuildFeature["PinPermissionMigrationComplete"] = "PIN_PERMISSION_MIGRATION_COMPLETE";
	})(GuildFeature || (exports.GuildFeature = GuildFeature = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object-guild-member-flags}
	*/
	var GuildMemberFlags;
	(function(GuildMemberFlags) {
		/**
		* Member has left and rejoined the guild
		*/
		GuildMemberFlags[GuildMemberFlags["DidRejoin"] = 1] = "DidRejoin";
		/**
		* Member has completed onboarding
		*/
		GuildMemberFlags[GuildMemberFlags["CompletedOnboarding"] = 2] = "CompletedOnboarding";
		/**
		* Member is exempt from guild verification requirements
		*/
		GuildMemberFlags[GuildMemberFlags["BypassesVerification"] = 4] = "BypassesVerification";
		/**
		* Member has started onboarding
		*/
		GuildMemberFlags[GuildMemberFlags["StartedOnboarding"] = 8] = "StartedOnboarding";
		/**
		* Member is a guest and can only access the voice channel they were invited to
		*/
		GuildMemberFlags[GuildMemberFlags["IsGuest"] = 16] = "IsGuest";
		/**
		* Member has started Server Guide new member actions
		*/
		GuildMemberFlags[GuildMemberFlags["StartedHomeActions"] = 32] = "StartedHomeActions";
		/**
		* Member has completed Server Guide new member actions
		*/
		GuildMemberFlags[GuildMemberFlags["CompletedHomeActions"] = 64] = "CompletedHomeActions";
		/**
		* Member's username, display name, or nickname is blocked by AutoMod
		*/
		GuildMemberFlags[GuildMemberFlags["AutomodQuarantinedUsernameOrGuildNickname"] = 128] = "AutomodQuarantinedUsernameOrGuildNickname";
		/**
		* @deprecated
		* {@link https://github.com/discord/discord-api-docs/pull/7113 | discord-api-docs#7113}
		*/
		GuildMemberFlags[GuildMemberFlags["AutomodQuarantinedBio"] = 256] = "AutomodQuarantinedBio";
		/**
		* Member has dismissed the DM settings upsell
		*/
		GuildMemberFlags[GuildMemberFlags["DmSettingsUpsellAcknowledged"] = 512] = "DmSettingsUpsellAcknowledged";
		/**
		* Member's guild tag is blocked by AutoMod
		*/
		GuildMemberFlags[GuildMemberFlags["AutoModQuarantinedGuildTag"] = 1024] = "AutoModQuarantinedGuildTag";
	})(GuildMemberFlags || (exports.GuildMemberFlags = GuildMemberFlags = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#integration-object-integration-expire-behaviors}
	*/
	var IntegrationExpireBehavior;
	(function(IntegrationExpireBehavior) {
		IntegrationExpireBehavior[IntegrationExpireBehavior["RemoveRole"] = 0] = "RemoveRole";
		IntegrationExpireBehavior[IntegrationExpireBehavior["Kick"] = 1] = "Kick";
	})(IntegrationExpireBehavior || (exports.IntegrationExpireBehavior = IntegrationExpireBehavior = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#get-guild-widget-image-widget-style-options}
	*/
	var GuildWidgetStyle;
	(function(GuildWidgetStyle) {
		/**
		* Shield style widget with Discord icon and guild members online count
		*/
		GuildWidgetStyle["Shield"] = "shield";
		/**
		* Large image with guild icon, name and online count. "POWERED BY DISCORD" as the footer of the widget
		*/
		GuildWidgetStyle["Banner1"] = "banner1";
		/**
		* Smaller widget style with guild icon, name and online count. Split on the right with Discord logo
		*/
		GuildWidgetStyle["Banner2"] = "banner2";
		/**
		* Large image with guild icon, name and online count. In the footer, Discord logo on the left and "Chat Now" on the right
		*/
		GuildWidgetStyle["Banner3"] = "banner3";
		/**
		* Large Discord logo at the top of the widget. Guild icon, name and online count in the middle portion of the widget
		* and a "JOIN MY SERVER" button at the bottom
		*/
		GuildWidgetStyle["Banner4"] = "banner4";
	})(GuildWidgetStyle || (exports.GuildWidgetStyle = GuildWidgetStyle = {}));
	/**
	* @unstable https://github.com/discord/discord-api-docs/pull/2547
	*/
	var MembershipScreeningFieldType;
	(function(MembershipScreeningFieldType) {
		/**
		* Server Rules
		*/
		MembershipScreeningFieldType["Terms"] = "TERMS";
	})(MembershipScreeningFieldType || (exports.MembershipScreeningFieldType = MembershipScreeningFieldType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#guild-onboarding-object-onboarding-mode}
	*/
	var GuildOnboardingMode;
	(function(GuildOnboardingMode) {
		/**
		* Counts only Default Channels towards constraints
		*/
		GuildOnboardingMode[GuildOnboardingMode["OnboardingDefault"] = 0] = "OnboardingDefault";
		/**
		* Counts Default Channels and Questions towards constraints
		*/
		GuildOnboardingMode[GuildOnboardingMode["OnboardingAdvanced"] = 1] = "OnboardingAdvanced";
	})(GuildOnboardingMode || (exports.GuildOnboardingMode = GuildOnboardingMode = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild#guild-onboarding-object-prompt-types}
	*/
	var GuildOnboardingPromptType;
	(function(GuildOnboardingPromptType) {
		GuildOnboardingPromptType[GuildOnboardingPromptType["MultipleChoice"] = 0] = "MultipleChoice";
		GuildOnboardingPromptType[GuildOnboardingPromptType["Dropdown"] = 1] = "Dropdown";
	})(GuildOnboardingPromptType || (exports.GuildOnboardingPromptType = GuildOnboardingPromptType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/guildScheduledEvent.js
var require_guildScheduledEvent = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.GuildScheduledEventPrivacyLevel = exports.GuildScheduledEventStatus = exports.GuildScheduledEventEntityType = exports.GuildScheduledEventRecurrenceRuleMonth = exports.GuildScheduledEventRecurrenceRuleWeekday = exports.GuildScheduledEventRecurrenceRuleFrequency = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-recurrence-rule-object-guild-scheduled-event-recurrence-rule-frequency}
	*/
	var GuildScheduledEventRecurrenceRuleFrequency;
	(function(GuildScheduledEventRecurrenceRuleFrequency) {
		GuildScheduledEventRecurrenceRuleFrequency[GuildScheduledEventRecurrenceRuleFrequency["Yearly"] = 0] = "Yearly";
		GuildScheduledEventRecurrenceRuleFrequency[GuildScheduledEventRecurrenceRuleFrequency["Monthly"] = 1] = "Monthly";
		GuildScheduledEventRecurrenceRuleFrequency[GuildScheduledEventRecurrenceRuleFrequency["Weekly"] = 2] = "Weekly";
		GuildScheduledEventRecurrenceRuleFrequency[GuildScheduledEventRecurrenceRuleFrequency["Daily"] = 3] = "Daily";
	})(GuildScheduledEventRecurrenceRuleFrequency || (exports.GuildScheduledEventRecurrenceRuleFrequency = GuildScheduledEventRecurrenceRuleFrequency = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-recurrence-rule-object-guild-scheduled-event-recurrence-rule-weekday}
	*/
	var GuildScheduledEventRecurrenceRuleWeekday;
	(function(GuildScheduledEventRecurrenceRuleWeekday) {
		GuildScheduledEventRecurrenceRuleWeekday[GuildScheduledEventRecurrenceRuleWeekday["Monday"] = 0] = "Monday";
		GuildScheduledEventRecurrenceRuleWeekday[GuildScheduledEventRecurrenceRuleWeekday["Tuesday"] = 1] = "Tuesday";
		GuildScheduledEventRecurrenceRuleWeekday[GuildScheduledEventRecurrenceRuleWeekday["Wednesday"] = 2] = "Wednesday";
		GuildScheduledEventRecurrenceRuleWeekday[GuildScheduledEventRecurrenceRuleWeekday["Thursday"] = 3] = "Thursday";
		GuildScheduledEventRecurrenceRuleWeekday[GuildScheduledEventRecurrenceRuleWeekday["Friday"] = 4] = "Friday";
		GuildScheduledEventRecurrenceRuleWeekday[GuildScheduledEventRecurrenceRuleWeekday["Saturday"] = 5] = "Saturday";
		GuildScheduledEventRecurrenceRuleWeekday[GuildScheduledEventRecurrenceRuleWeekday["Sunday"] = 6] = "Sunday";
	})(GuildScheduledEventRecurrenceRuleWeekday || (exports.GuildScheduledEventRecurrenceRuleWeekday = GuildScheduledEventRecurrenceRuleWeekday = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-recurrence-rule-object-guild-scheduled-event-recurrence-rule-month}
	*/
	var GuildScheduledEventRecurrenceRuleMonth;
	(function(GuildScheduledEventRecurrenceRuleMonth) {
		GuildScheduledEventRecurrenceRuleMonth[GuildScheduledEventRecurrenceRuleMonth["January"] = 1] = "January";
		GuildScheduledEventRecurrenceRuleMonth[GuildScheduledEventRecurrenceRuleMonth["February"] = 2] = "February";
		GuildScheduledEventRecurrenceRuleMonth[GuildScheduledEventRecurrenceRuleMonth["March"] = 3] = "March";
		GuildScheduledEventRecurrenceRuleMonth[GuildScheduledEventRecurrenceRuleMonth["April"] = 4] = "April";
		GuildScheduledEventRecurrenceRuleMonth[GuildScheduledEventRecurrenceRuleMonth["May"] = 5] = "May";
		GuildScheduledEventRecurrenceRuleMonth[GuildScheduledEventRecurrenceRuleMonth["June"] = 6] = "June";
		GuildScheduledEventRecurrenceRuleMonth[GuildScheduledEventRecurrenceRuleMonth["July"] = 7] = "July";
		GuildScheduledEventRecurrenceRuleMonth[GuildScheduledEventRecurrenceRuleMonth["August"] = 8] = "August";
		GuildScheduledEventRecurrenceRuleMonth[GuildScheduledEventRecurrenceRuleMonth["September"] = 9] = "September";
		GuildScheduledEventRecurrenceRuleMonth[GuildScheduledEventRecurrenceRuleMonth["October"] = 10] = "October";
		GuildScheduledEventRecurrenceRuleMonth[GuildScheduledEventRecurrenceRuleMonth["November"] = 11] = "November";
		GuildScheduledEventRecurrenceRuleMonth[GuildScheduledEventRecurrenceRuleMonth["December"] = 12] = "December";
	})(GuildScheduledEventRecurrenceRuleMonth || (exports.GuildScheduledEventRecurrenceRuleMonth = GuildScheduledEventRecurrenceRuleMonth = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-object-guild-scheduled-event-entity-types}
	*/
	var GuildScheduledEventEntityType;
	(function(GuildScheduledEventEntityType) {
		GuildScheduledEventEntityType[GuildScheduledEventEntityType["StageInstance"] = 1] = "StageInstance";
		GuildScheduledEventEntityType[GuildScheduledEventEntityType["Voice"] = 2] = "Voice";
		GuildScheduledEventEntityType[GuildScheduledEventEntityType["External"] = 3] = "External";
	})(GuildScheduledEventEntityType || (exports.GuildScheduledEventEntityType = GuildScheduledEventEntityType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-object-guild-scheduled-event-status}
	*/
	var GuildScheduledEventStatus;
	(function(GuildScheduledEventStatus) {
		GuildScheduledEventStatus[GuildScheduledEventStatus["Scheduled"] = 1] = "Scheduled";
		GuildScheduledEventStatus[GuildScheduledEventStatus["Active"] = 2] = "Active";
		GuildScheduledEventStatus[GuildScheduledEventStatus["Completed"] = 3] = "Completed";
		GuildScheduledEventStatus[GuildScheduledEventStatus["Canceled"] = 4] = "Canceled";
	})(GuildScheduledEventStatus || (exports.GuildScheduledEventStatus = GuildScheduledEventStatus = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-object-guild-scheduled-event-privacy-level}
	*/
	var GuildScheduledEventPrivacyLevel;
	(function(GuildScheduledEventPrivacyLevel) {
		/**
		* The scheduled event is only accessible to guild members
		*/
		GuildScheduledEventPrivacyLevel[GuildScheduledEventPrivacyLevel["GuildOnly"] = 2] = "GuildOnly";
	})(GuildScheduledEventPrivacyLevel || (exports.GuildScheduledEventPrivacyLevel = GuildScheduledEventPrivacyLevel = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/_chatInput/shared.js
var require_shared = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ApplicationCommandOptionType = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-type}
	*/
	var ApplicationCommandOptionType;
	(function(ApplicationCommandOptionType) {
		ApplicationCommandOptionType[ApplicationCommandOptionType["Subcommand"] = 1] = "Subcommand";
		ApplicationCommandOptionType[ApplicationCommandOptionType["SubcommandGroup"] = 2] = "SubcommandGroup";
		ApplicationCommandOptionType[ApplicationCommandOptionType["String"] = 3] = "String";
		ApplicationCommandOptionType[ApplicationCommandOptionType["Integer"] = 4] = "Integer";
		ApplicationCommandOptionType[ApplicationCommandOptionType["Boolean"] = 5] = "Boolean";
		ApplicationCommandOptionType[ApplicationCommandOptionType["User"] = 6] = "User";
		ApplicationCommandOptionType[ApplicationCommandOptionType["Channel"] = 7] = "Channel";
		ApplicationCommandOptionType[ApplicationCommandOptionType["Role"] = 8] = "Role";
		ApplicationCommandOptionType[ApplicationCommandOptionType["Mentionable"] = 9] = "Mentionable";
		ApplicationCommandOptionType[ApplicationCommandOptionType["Number"] = 10] = "Number";
		ApplicationCommandOptionType[ApplicationCommandOptionType["Attachment"] = 11] = "Attachment";
	})(ApplicationCommandOptionType || (exports.ApplicationCommandOptionType = ApplicationCommandOptionType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/chatInput.js
var require_chatInput = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$7) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$7, p)) __createBinding(exports$7, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_shared(), exports);
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/_applicationCommands/permissions.js
var require_permissions$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.APIApplicationCommandPermissionsConstant = exports.ApplicationCommandPermissionType = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-permissions-object-application-command-permission-type}
	*/
	var ApplicationCommandPermissionType;
	(function(ApplicationCommandPermissionType) {
		ApplicationCommandPermissionType[ApplicationCommandPermissionType["Role"] = 1] = "Role";
		ApplicationCommandPermissionType[ApplicationCommandPermissionType["User"] = 2] = "User";
		ApplicationCommandPermissionType[ApplicationCommandPermissionType["Channel"] = 3] = "Channel";
	})(ApplicationCommandPermissionType || (exports.ApplicationCommandPermissionType = ApplicationCommandPermissionType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-permissions-object-application-command-permissions-constants}
	*/
	exports.APIApplicationCommandPermissionsConstant = {
		Everyone: (guildId) => String(guildId),
		AllChannels: (guildId) => String(BigInt(guildId) - 1n)
	};
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/applicationCommands.js
var require_applicationCommands = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$6) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$6, p)) __createBinding(exports$6, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.EntryPointCommandHandlerType = exports.InteractionContextType = exports.ApplicationIntegrationType = exports.ApplicationCommandType = void 0;
	__exportStar(require_chatInput(), exports);
	__exportStar(require_permissions$1(), exports);
	/**
	* @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-types}
	*/
	var ApplicationCommandType;
	(function(ApplicationCommandType) {
		/**
		* Slash commands; a text-based command that shows up when a user types `/`
		*/
		ApplicationCommandType[ApplicationCommandType["ChatInput"] = 1] = "ChatInput";
		/**
		* A UI-based command that shows up when you right click or tap on a user
		*/
		ApplicationCommandType[ApplicationCommandType["User"] = 2] = "User";
		/**
		* A UI-based command that shows up when you right click or tap on a message
		*/
		ApplicationCommandType[ApplicationCommandType["Message"] = 3] = "Message";
		/**
		* A UI-based command that represents the primary way to invoke an app's Activity
		*/
		ApplicationCommandType[ApplicationCommandType["PrimaryEntryPoint"] = 4] = "PrimaryEntryPoint";
	})(ApplicationCommandType || (exports.ApplicationCommandType = ApplicationCommandType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/application#application-object-application-integration-types}
	*/
	var ApplicationIntegrationType;
	(function(ApplicationIntegrationType) {
		/**
		* App is installable to servers
		*/
		ApplicationIntegrationType[ApplicationIntegrationType["GuildInstall"] = 0] = "GuildInstall";
		/**
		* App is installable to users
		*/
		ApplicationIntegrationType[ApplicationIntegrationType["UserInstall"] = 1] = "UserInstall";
	})(ApplicationIntegrationType || (exports.ApplicationIntegrationType = ApplicationIntegrationType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-context-types}
	*/
	var InteractionContextType;
	(function(InteractionContextType) {
		/**
		* Interaction can be used within servers
		*/
		InteractionContextType[InteractionContextType["Guild"] = 0] = "Guild";
		/**
		* Interaction can be used within DMs with the app's bot user
		*/
		InteractionContextType[InteractionContextType["BotDM"] = 1] = "BotDM";
		/**
		* Interaction can be used within Group DMs and DMs other than the app's bot user
		*/
		InteractionContextType[InteractionContextType["PrivateChannel"] = 2] = "PrivateChannel";
	})(InteractionContextType || (exports.InteractionContextType = InteractionContextType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/interactions/application-commands#application-command-object-entry-point-command-handler-types}
	*/
	var EntryPointCommandHandlerType;
	(function(EntryPointCommandHandlerType) {
		/**
		* The app handles the interaction using an interaction token
		*/
		EntryPointCommandHandlerType[EntryPointCommandHandlerType["AppHandler"] = 1] = "AppHandler";
		/**
		* Discord handles the interaction by launching an Activity and sending a follow-up message without coordinating with
		* the app
		*/
		EntryPointCommandHandlerType[EntryPointCommandHandlerType["DiscordLaunchActivity"] = 2] = "DiscordLaunchActivity";
	})(EntryPointCommandHandlerType || (exports.EntryPointCommandHandlerType = EntryPointCommandHandlerType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/_interactions/responses.js
var require_responses = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.InteractionResponseType = exports.InteractionType = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-type}
	*/
	var InteractionType;
	(function(InteractionType) {
		InteractionType[InteractionType["Ping"] = 1] = "Ping";
		InteractionType[InteractionType["ApplicationCommand"] = 2] = "ApplicationCommand";
		InteractionType[InteractionType["MessageComponent"] = 3] = "MessageComponent";
		InteractionType[InteractionType["ApplicationCommandAutocomplete"] = 4] = "ApplicationCommandAutocomplete";
		InteractionType[InteractionType["ModalSubmit"] = 5] = "ModalSubmit";
	})(InteractionType || (exports.InteractionType = InteractionType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type}
	*/
	var InteractionResponseType;
	(function(InteractionResponseType) {
		/**
		* ACK a `Ping`
		*/
		InteractionResponseType[InteractionResponseType["Pong"] = 1] = "Pong";
		/**
		* Respond to an interaction with a message
		*/
		InteractionResponseType[InteractionResponseType["ChannelMessageWithSource"] = 4] = "ChannelMessageWithSource";
		/**
		* ACK an interaction and edit to a response later, the user sees a loading state
		*/
		InteractionResponseType[InteractionResponseType["DeferredChannelMessageWithSource"] = 5] = "DeferredChannelMessageWithSource";
		/**
		* ACK a button interaction and update it to a loading state
		*/
		InteractionResponseType[InteractionResponseType["DeferredMessageUpdate"] = 6] = "DeferredMessageUpdate";
		/**
		* ACK a button interaction and edit the message to which the button was attached
		*/
		InteractionResponseType[InteractionResponseType["UpdateMessage"] = 7] = "UpdateMessage";
		/**
		* For autocomplete interactions
		*/
		InteractionResponseType[InteractionResponseType["ApplicationCommandAutocompleteResult"] = 8] = "ApplicationCommandAutocompleteResult";
		/**
		* Respond to an interaction with an modal for a user to fill-out
		*/
		InteractionResponseType[InteractionResponseType["Modal"] = 9] = "Modal";
		/**
		* Respond to an interaction with an upgrade button, only available for apps with monetization enabled
		*
		* @deprecated Send a button with Premium type instead.
		* {@link https://discord.com/developers/docs/change-log#premium-apps-new-premium-button-style-deep-linking-url-schemes | Learn more here}
		*/
		InteractionResponseType[InteractionResponseType["PremiumRequired"] = 10] = "PremiumRequired";
		/**
		* Launch the Activity associated with the app.
		*
		* @remarks
		* Only available for apps with Activities enabled
		*/
		InteractionResponseType[InteractionResponseType["LaunchActivity"] = 12] = "LaunchActivity";
	})(InteractionResponseType || (exports.InteractionResponseType = InteractionResponseType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/interactions.js
var require_interactions = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$5) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$5, p)) __createBinding(exports$5, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_applicationCommands(), exports);
	__exportStar(require_responses(), exports);
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/invite.js
var require_invite = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/resources/invite
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.InviteTargetType = exports.InviteType = exports.InviteFlags = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/invite#invite-object-guild-invite-flags}
	*/
	var InviteFlags;
	(function(InviteFlags) {
		InviteFlags[InviteFlags["IsGuestInvite"] = 1] = "IsGuestInvite";
	})(InviteFlags || (exports.InviteFlags = InviteFlags = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/invite#invite-object-invite-types}
	*/
	var InviteType;
	(function(InviteType) {
		InviteType[InviteType["Guild"] = 0] = "Guild";
		InviteType[InviteType["GroupDM"] = 1] = "GroupDM";
		InviteType[InviteType["Friend"] = 2] = "Friend";
	})(InviteType || (exports.InviteType = InviteType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/invite#invite-object-invite-target-types}
	*/
	var InviteTargetType;
	(function(InviteTargetType) {
		InviteTargetType[InviteTargetType["Stream"] = 1] = "Stream";
		InviteTargetType[InviteTargetType["EmbeddedApplication"] = 2] = "EmbeddedApplication";
	})(InviteTargetType || (exports.InviteTargetType = InviteTargetType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/message.js
var require_message = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.MessageSearchSortMode = exports.MessageSearchEmbedType = exports.MessageSearchHasType = exports.MessageSearchAuthorType = exports.SeparatorSpacingSize = exports.UnfurledMediaItemFlags = exports.UnfurledMediaItemLoadingState = exports.SelectMenuDefaultValueType = exports.TextInputStyle = exports.ButtonStyle = exports.ComponentType = exports.AllowedMentionsTypes = exports.AttachmentFlags = exports.EmbedMediaFlags = exports.EmbedFlags = exports.EmbedType = exports.BaseThemeType = exports.MessageFlags = exports.MessageReferenceType = exports.MessageActivityType = exports.MessageType = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/message#message-object-message-types}
	*/
	var MessageType;
	(function(MessageType) {
		MessageType[MessageType["Default"] = 0] = "Default";
		MessageType[MessageType["RecipientAdd"] = 1] = "RecipientAdd";
		MessageType[MessageType["RecipientRemove"] = 2] = "RecipientRemove";
		MessageType[MessageType["Call"] = 3] = "Call";
		MessageType[MessageType["ChannelNameChange"] = 4] = "ChannelNameChange";
		MessageType[MessageType["ChannelIconChange"] = 5] = "ChannelIconChange";
		MessageType[MessageType["ChannelPinnedMessage"] = 6] = "ChannelPinnedMessage";
		MessageType[MessageType["UserJoin"] = 7] = "UserJoin";
		MessageType[MessageType["GuildBoost"] = 8] = "GuildBoost";
		MessageType[MessageType["GuildBoostTier1"] = 9] = "GuildBoostTier1";
		MessageType[MessageType["GuildBoostTier2"] = 10] = "GuildBoostTier2";
		MessageType[MessageType["GuildBoostTier3"] = 11] = "GuildBoostTier3";
		MessageType[MessageType["ChannelFollowAdd"] = 12] = "ChannelFollowAdd";
		MessageType[MessageType["GuildDiscoveryDisqualified"] = 14] = "GuildDiscoveryDisqualified";
		MessageType[MessageType["GuildDiscoveryRequalified"] = 15] = "GuildDiscoveryRequalified";
		MessageType[MessageType["GuildDiscoveryGracePeriodInitialWarning"] = 16] = "GuildDiscoveryGracePeriodInitialWarning";
		MessageType[MessageType["GuildDiscoveryGracePeriodFinalWarning"] = 17] = "GuildDiscoveryGracePeriodFinalWarning";
		MessageType[MessageType["ThreadCreated"] = 18] = "ThreadCreated";
		MessageType[MessageType["Reply"] = 19] = "Reply";
		MessageType[MessageType["ChatInputCommand"] = 20] = "ChatInputCommand";
		MessageType[MessageType["ThreadStarterMessage"] = 21] = "ThreadStarterMessage";
		MessageType[MessageType["GuildInviteReminder"] = 22] = "GuildInviteReminder";
		MessageType[MessageType["ContextMenuCommand"] = 23] = "ContextMenuCommand";
		MessageType[MessageType["AutoModerationAction"] = 24] = "AutoModerationAction";
		MessageType[MessageType["RoleSubscriptionPurchase"] = 25] = "RoleSubscriptionPurchase";
		MessageType[MessageType["InteractionPremiumUpsell"] = 26] = "InteractionPremiumUpsell";
		MessageType[MessageType["StageStart"] = 27] = "StageStart";
		MessageType[MessageType["StageEnd"] = 28] = "StageEnd";
		MessageType[MessageType["StageSpeaker"] = 29] = "StageSpeaker";
		/**
		* @unstable https://github.com/discord/discord-api-docs/pull/5927#discussion_r1107678548
		*/
		MessageType[MessageType["StageRaiseHand"] = 30] = "StageRaiseHand";
		MessageType[MessageType["StageTopic"] = 31] = "StageTopic";
		MessageType[MessageType["GuildApplicationPremiumSubscription"] = 32] = "GuildApplicationPremiumSubscription";
		MessageType[MessageType["GuildIncidentAlertModeEnabled"] = 36] = "GuildIncidentAlertModeEnabled";
		MessageType[MessageType["GuildIncidentAlertModeDisabled"] = 37] = "GuildIncidentAlertModeDisabled";
		MessageType[MessageType["GuildIncidentReportRaid"] = 38] = "GuildIncidentReportRaid";
		MessageType[MessageType["GuildIncidentReportFalseAlarm"] = 39] = "GuildIncidentReportFalseAlarm";
		MessageType[MessageType["PurchaseNotification"] = 44] = "PurchaseNotification";
		MessageType[MessageType["PollResult"] = 46] = "PollResult";
	})(MessageType || (exports.MessageType = MessageType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/message#message-object-message-activity-types}
	*/
	var MessageActivityType;
	(function(MessageActivityType) {
		MessageActivityType[MessageActivityType["Join"] = 1] = "Join";
		MessageActivityType[MessageActivityType["Spectate"] = 2] = "Spectate";
		MessageActivityType[MessageActivityType["Listen"] = 3] = "Listen";
		MessageActivityType[MessageActivityType["JoinRequest"] = 5] = "JoinRequest";
	})(MessageActivityType || (exports.MessageActivityType = MessageActivityType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/message#message-reference-types}
	*/
	var MessageReferenceType;
	(function(MessageReferenceType) {
		/**
		* A standard reference used by replies
		*/
		MessageReferenceType[MessageReferenceType["Default"] = 0] = "Default";
		/**
		* Reference used to point to a message at a point in time
		*/
		MessageReferenceType[MessageReferenceType["Forward"] = 1] = "Forward";
	})(MessageReferenceType || (exports.MessageReferenceType = MessageReferenceType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/message#message-object-message-flags}
	*/
	var MessageFlags;
	(function(MessageFlags) {
		/**
		* This message has been published to subscribed channels (via Channel Following)
		*/
		MessageFlags[MessageFlags["Crossposted"] = 1] = "Crossposted";
		/**
		* This message originated from a message in another channel (via Channel Following)
		*/
		MessageFlags[MessageFlags["IsCrosspost"] = 2] = "IsCrosspost";
		/**
		* Do not include any embeds when serializing this message
		*/
		MessageFlags[MessageFlags["SuppressEmbeds"] = 4] = "SuppressEmbeds";
		/**
		* The source message for this crosspost has been deleted (via Channel Following)
		*/
		MessageFlags[MessageFlags["SourceMessageDeleted"] = 8] = "SourceMessageDeleted";
		/**
		* This message came from the urgent message system
		*/
		MessageFlags[MessageFlags["Urgent"] = 16] = "Urgent";
		/**
		* This message has an associated thread, which shares its id
		*/
		MessageFlags[MessageFlags["HasThread"] = 32] = "HasThread";
		/**
		* This message is only visible to the user who invoked the Interaction
		*/
		MessageFlags[MessageFlags["Ephemeral"] = 64] = "Ephemeral";
		/**
		* This message is an Interaction Response and the bot is "thinking"
		*/
		MessageFlags[MessageFlags["Loading"] = 128] = "Loading";
		/**
		* This message failed to mention some roles and add their members to the thread
		*/
		MessageFlags[MessageFlags["FailedToMentionSomeRolesInThread"] = 256] = "FailedToMentionSomeRolesInThread";
		/**
		* @unstable This message flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		MessageFlags[MessageFlags["ShouldShowLinkNotDiscordWarning"] = 1024] = "ShouldShowLinkNotDiscordWarning";
		/**
		* This message will not trigger push and desktop notifications
		*/
		MessageFlags[MessageFlags["SuppressNotifications"] = 4096] = "SuppressNotifications";
		/**
		* This message is a voice message
		*/
		MessageFlags[MessageFlags["IsVoiceMessage"] = 8192] = "IsVoiceMessage";
		/**
		* This message has a snapshot (via Message Forwarding)
		*/
		MessageFlags[MessageFlags["HasSnapshot"] = 16384] = "HasSnapshot";
		/**
		* Allows you to create fully component-driven messages
		*
		* @see {@link https://discord.com/developers/docs/components/overview}
		*/
		MessageFlags[MessageFlags["IsComponentsV2"] = 32768] = "IsComponentsV2";
	})(MessageFlags || (exports.MessageFlags = MessageFlags = {}));
	/**
	* @see https://docs.discord.com/developers/resources/message#base-theme-types
	*/
	var BaseThemeType;
	(function(BaseThemeType) {
		BaseThemeType[BaseThemeType["Unset"] = 0] = "Unset";
		BaseThemeType[BaseThemeType["Dark"] = 1] = "Dark";
		BaseThemeType[BaseThemeType["Light"] = 2] = "Light";
		BaseThemeType[BaseThemeType["Darker"] = 3] = "Darker";
		BaseThemeType[BaseThemeType["Midnight"] = 4] = "Midnight";
	})(BaseThemeType || (exports.BaseThemeType = BaseThemeType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/message#embed-object-embed-types}
	*/
	var EmbedType;
	(function(EmbedType) {
		/**
		* Generic embed rendered from embed attributes
		*/
		EmbedType["Rich"] = "rich";
		/**
		* Image embed
		*/
		EmbedType["Image"] = "image";
		/**
		* Video embed
		*/
		EmbedType["Video"] = "video";
		/**
		* Animated gif image embed rendered as a video embed
		*/
		EmbedType["GIFV"] = "gifv";
		/**
		* Article embed
		*/
		EmbedType["Article"] = "article";
		/**
		* Link embed
		*/
		EmbedType["Link"] = "link";
		/**
		* Auto moderation alert embed
		*
		* @unstable This embed type is currently not documented by Discord, but it is returned in the auto moderation system messages.
		*/
		EmbedType["AutoModerationMessage"] = "auto_moderation_message";
		/**
		* Poll result embed
		*/
		EmbedType["PollResult"] = "poll_result";
	})(EmbedType || (exports.EmbedType = EmbedType = {}));
	/**
	* @see {@link https://docs.discord.com/developers/resources/message#embed-object-embed-flags}
	*/
	var EmbedFlags;
	(function(EmbedFlags) {
		/**
		* This embed is a fallback for a reply to an activity card
		*/
		EmbedFlags[EmbedFlags["IsContentInventoryEntry"] = 32] = "IsContentInventoryEntry";
	})(EmbedFlags || (exports.EmbedFlags = EmbedFlags = {}));
	/**
	* @see {@link https://docs.discord.com/developers/resources/message#embed-object-embed-media-flags}
	*/
	var EmbedMediaFlags;
	(function(EmbedMediaFlags) {
		/**
		* This image is animated
		*/
		EmbedMediaFlags[EmbedMediaFlags["IsAnimated"] = 32] = "IsAnimated";
	})(EmbedMediaFlags || (exports.EmbedMediaFlags = EmbedMediaFlags = {}));
	/**
	* @see {@link https://docs.discord.com/developers/resources/message#attachment-object-attachment-flags}
	*/
	var AttachmentFlags;
	(function(AttachmentFlags) {
		/**
		* This attachment is a Clip from a stream
		*
		* @see {@link https://support.discord.com/hc/en-us/articles/16861982215703}
		*/
		AttachmentFlags[AttachmentFlags["IsClip"] = 1] = "IsClip";
		/**
		* This attachment is the thumbnail of a thread in a media channel, displayed in the grid but not on the message
		*/
		AttachmentFlags[AttachmentFlags["IsThumbnail"] = 2] = "IsThumbnail";
		/**
		* This attachment has been edited using the remix feature on mobile
		*
		* @deprecated
		*/
		AttachmentFlags[AttachmentFlags["IsRemix"] = 4] = "IsRemix";
		/**
		* This attachment was marked as a spoiler and is blurred until clicked
		*/
		AttachmentFlags[AttachmentFlags["IsSpoiler"] = 8] = "IsSpoiler";
		/**
		* This attachment is an animated image
		*/
		AttachmentFlags[AttachmentFlags["IsAnimated"] = 32] = "IsAnimated";
	})(AttachmentFlags || (exports.AttachmentFlags = AttachmentFlags = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/message#allowed-mentions-object-allowed-mention-types}
	*/
	var AllowedMentionsTypes;
	(function(AllowedMentionsTypes) {
		/**
		* Controls `@everyone` and `@here` mentions
		*/
		AllowedMentionsTypes["Everyone"] = "everyone";
		/**
		* Controls role mentions
		*/
		AllowedMentionsTypes["Role"] = "roles";
		/**
		* Controls user mentions
		*/
		AllowedMentionsTypes["User"] = "users";
	})(AllowedMentionsTypes || (exports.AllowedMentionsTypes = AllowedMentionsTypes = {}));
	/**
	* @see {@link https://discord.com/developers/docs/components/reference#component-object-component-types}
	*/
	var ComponentType;
	(function(ComponentType) {
		/**
		* Container to display a row of interactive components
		*/
		ComponentType[ComponentType["ActionRow"] = 1] = "ActionRow";
		/**
		* Button component
		*/
		ComponentType[ComponentType["Button"] = 2] = "Button";
		/**
		* Select menu for picking from defined text options
		*/
		ComponentType[ComponentType["StringSelect"] = 3] = "StringSelect";
		/**
		* Text Input component
		*/
		ComponentType[ComponentType["TextInput"] = 4] = "TextInput";
		/**
		* Select menu for users
		*/
		ComponentType[ComponentType["UserSelect"] = 5] = "UserSelect";
		/**
		* Select menu for roles
		*/
		ComponentType[ComponentType["RoleSelect"] = 6] = "RoleSelect";
		/**
		* Select menu for users and roles
		*/
		ComponentType[ComponentType["MentionableSelect"] = 7] = "MentionableSelect";
		/**
		* Select menu for channels
		*/
		ComponentType[ComponentType["ChannelSelect"] = 8] = "ChannelSelect";
		/**
		* Container to display text alongside an accessory component
		*/
		ComponentType[ComponentType["Section"] = 9] = "Section";
		/**
		* Markdown text
		*/
		ComponentType[ComponentType["TextDisplay"] = 10] = "TextDisplay";
		/**
		* Small image that can be used as an accessory
		*/
		ComponentType[ComponentType["Thumbnail"] = 11] = "Thumbnail";
		/**
		* Display images and other media
		*/
		ComponentType[ComponentType["MediaGallery"] = 12] = "MediaGallery";
		/**
		* Displays an attached file
		*/
		ComponentType[ComponentType["File"] = 13] = "File";
		/**
		* Component to add vertical padding between other components
		*/
		ComponentType[ComponentType["Separator"] = 14] = "Separator";
		/**
		* @unstable This component type is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		ComponentType[ComponentType["ContentInventoryEntry"] = 16] = "ContentInventoryEntry";
		/**
		* Container that visually groups a set of components
		*/
		ComponentType[ComponentType["Container"] = 17] = "Container";
		/**
		* Container associating a label and description with a component
		*/
		ComponentType[ComponentType["Label"] = 18] = "Label";
		/**
		* Component for uploading files
		*/
		ComponentType[ComponentType["FileUpload"] = 19] = "FileUpload";
		/**
		* Single-choice set of radio group option
		*/
		ComponentType[ComponentType["RadioGroup"] = 21] = "RadioGroup";
		/**
		* Multi-select group of checkboxes
		*/
		ComponentType[ComponentType["CheckboxGroup"] = 22] = "CheckboxGroup";
		/**
		* Single checkbox for binary choice
		*/
		ComponentType[ComponentType["Checkbox"] = 23] = "Checkbox";
		/**
		* Select menu for picking from defined text options
		*
		* @deprecated This is the old name for {@link ComponentType.StringSelect}
		*/
		ComponentType[ComponentType["SelectMenu"] = 3] = "SelectMenu";
	})(ComponentType || (exports.ComponentType = ComponentType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/components/reference#button-button-styles}
	*/
	var ButtonStyle;
	(function(ButtonStyle) {
		/**
		* The most important or recommended action in a group of options
		*/
		ButtonStyle[ButtonStyle["Primary"] = 1] = "Primary";
		/**
		* Alternative or supporting actions
		*/
		ButtonStyle[ButtonStyle["Secondary"] = 2] = "Secondary";
		/**
		* Positive confirmation or completion actions
		*/
		ButtonStyle[ButtonStyle["Success"] = 3] = "Success";
		/**
		* An action with irreversible consequences
		*/
		ButtonStyle[ButtonStyle["Danger"] = 4] = "Danger";
		/**
		* Navigates to a URL
		*/
		ButtonStyle[ButtonStyle["Link"] = 5] = "Link";
		/**
		* Purchase
		*/
		ButtonStyle[ButtonStyle["Premium"] = 6] = "Premium";
	})(ButtonStyle || (exports.ButtonStyle = ButtonStyle = {}));
	/**
	* @see {@link https://discord.com/developers/docs/components/reference#text-input-text-input-styles}
	*/
	var TextInputStyle;
	(function(TextInputStyle) {
		/**
		* Single-line input
		*/
		TextInputStyle[TextInputStyle["Short"] = 1] = "Short";
		/**
		* Multi-line input
		*/
		TextInputStyle[TextInputStyle["Paragraph"] = 2] = "Paragraph";
	})(TextInputStyle || (exports.TextInputStyle = TextInputStyle = {}));
	/**
	* @see {@link https://discord.com/developers/docs/components/reference#user-select-select-default-value-structure}
	*/
	var SelectMenuDefaultValueType;
	(function(SelectMenuDefaultValueType) {
		SelectMenuDefaultValueType["Channel"] = "channel";
		SelectMenuDefaultValueType["Role"] = "role";
		SelectMenuDefaultValueType["User"] = "user";
	})(SelectMenuDefaultValueType || (exports.SelectMenuDefaultValueType = SelectMenuDefaultValueType = {}));
	/**
	* @unstable This enum is currently not documented by Discord
	*/
	var UnfurledMediaItemLoadingState;
	(function(UnfurledMediaItemLoadingState) {
		UnfurledMediaItemLoadingState[UnfurledMediaItemLoadingState["Unknown"] = 0] = "Unknown";
		UnfurledMediaItemLoadingState[UnfurledMediaItemLoadingState["Loading"] = 1] = "Loading";
		UnfurledMediaItemLoadingState[UnfurledMediaItemLoadingState["LoadedSuccess"] = 2] = "LoadedSuccess";
		UnfurledMediaItemLoadingState[UnfurledMediaItemLoadingState["LoadedNotFound"] = 3] = "LoadedNotFound";
	})(UnfurledMediaItemLoadingState || (exports.UnfurledMediaItemLoadingState = UnfurledMediaItemLoadingState = {}));
	/**
	* @see {@link https://docs.discord.com/developers/components/reference#unfurled-media-item-unfurled-media-item-flags}
	*/
	var UnfurledMediaItemFlags;
	(function(UnfurledMediaItemFlags) {
		/**
		* This image is animated
		*/
		UnfurledMediaItemFlags[UnfurledMediaItemFlags["IsAnimated"] = 1] = "IsAnimated";
	})(UnfurledMediaItemFlags || (exports.UnfurledMediaItemFlags = UnfurledMediaItemFlags = {}));
	/**
	* @see {@link https://discord.com/developers/docs/components/reference#separator}
	*/
	var SeparatorSpacingSize;
	(function(SeparatorSpacingSize) {
		SeparatorSpacingSize[SeparatorSpacingSize["Small"] = 1] = "Small";
		SeparatorSpacingSize[SeparatorSpacingSize["Large"] = 2] = "Large";
	})(SeparatorSpacingSize || (exports.SeparatorSpacingSize = SeparatorSpacingSize = {}));
	/**
	* @remarks All types can be negated by prefixing them with `-`, which means results will not include messages that match the type.
	* @see {@link https://docs.discord.com/developers/resources/message#search-guild-messages-author-types}
	*/
	var MessageSearchAuthorType;
	(function(MessageSearchAuthorType) {
		/**
		* Return messages sent by user accounts
		*/
		MessageSearchAuthorType["User"] = "user";
		/**
		* Return messages sent by bot accounts
		*/
		MessageSearchAuthorType["Bot"] = "bot";
		/**
		* Return messages sent by webhooks
		*/
		MessageSearchAuthorType["Webhook"] = "webhook";
		/**
		* Return messages not sent by user accounts
		*/
		MessageSearchAuthorType["NotUser"] = "-user";
		/**
		* Return messages not sent by bot accounts
		*/
		MessageSearchAuthorType["NotBot"] = "-bot";
		/**
		* Return messages not sent by webhooks
		*/
		MessageSearchAuthorType["NotWebhook"] = "-webhook";
	})(MessageSearchAuthorType || (exports.MessageSearchAuthorType = MessageSearchAuthorType = {}));
	/**
	* @remarks All types can be negated by prefixing them with `-`, which means results will not include messages that match the type.
	* @see {@link https://docs.discord.com/developers/resources/message#search-guild-messages-search-has-types}
	*/
	var MessageSearchHasType;
	(function(MessageSearchHasType) {
		/**
		* Return messages that have an image
		*/
		MessageSearchHasType["Image"] = "image";
		/**
		* Return messages that have a sound attachment
		*/
		MessageSearchHasType["Sound"] = "sound";
		/**
		* Return messages that have a video
		*/
		MessageSearchHasType["Video"] = "video";
		/**
		* Return messages that have an attachment
		*/
		MessageSearchHasType["File"] = "file";
		/**
		* Return messages that have a sent sticker
		*/
		MessageSearchHasType["Sticker"] = "sticker";
		/**
		* Return messages that have an embed
		*/
		MessageSearchHasType["Embed"] = "embed";
		/**
		* Return messages that have a link
		*/
		MessageSearchHasType["Link"] = "link";
		/**
		* Return messages that have a poll
		*/
		MessageSearchHasType["Poll"] = "poll";
		/**
		* Return messages that have a forwarded message
		*/
		MessageSearchHasType["Snapshot"] = "snapshot";
		/**
		* Return messages that don't have an image
		*/
		MessageSearchHasType["NotImage"] = "-image";
		/**
		* Return messages that don't have a sound attachment
		*/
		MessageSearchHasType["NotSound"] = "-sound";
		/**
		* Return messages that don't have a video
		*/
		MessageSearchHasType["NotVideo"] = "-video";
		/**
		* Return messages that don't have an attachment
		*/
		MessageSearchHasType["NotFile"] = "-file";
		/**
		* Return messages that don't have a sent sticker
		*/
		MessageSearchHasType["NotSticker"] = "-sticker";
		/**
		* Return messages that don't have an embed
		*/
		MessageSearchHasType["NotEmbed"] = "-embed";
		/**
		* Return messages that don't have a link
		*/
		MessageSearchHasType["NotLink"] = "-link";
		/**
		* Return messages that don't have a poll
		*/
		MessageSearchHasType["NotPoll"] = "-poll";
		/**
		* Return messages that don't have a forwarded message
		*/
		MessageSearchHasType["NotSnapshot"] = "-snapshot";
	})(MessageSearchHasType || (exports.MessageSearchHasType = MessageSearchHasType = {}));
	/**
	* @remarks These do not correspond 1:1 to actual {@link https://docs.discord.com/developers/resources/message#embed-object-embed-types | embed types} and encompass a wider range of actual types.
	* @see {@link https://docs.discord.com/developers/resources/message#search-guild-messages-search-embed-types}
	*/
	var MessageSearchEmbedType;
	(function(MessageSearchEmbedType) {
		/**
		* Return messages that have an image embed
		*/
		MessageSearchEmbedType["Image"] = "image";
		/**
		* Return messages that have a video embed
		*/
		MessageSearchEmbedType["Video"] = "video";
		/**
		* Return messages that have a gifv embed
		*
		* @remarks Messages sent before February 24, 2026 may not be properly indexed under the `gif` embed type.
		*/
		MessageSearchEmbedType["Gif"] = "gif";
		/**
		* Return messages that have a sound embed
		*/
		MessageSearchEmbedType["Sound"] = "sound";
		/**
		* Return messages that have an article embed
		*/
		MessageSearchEmbedType["Article"] = "article";
	})(MessageSearchEmbedType || (exports.MessageSearchEmbedType = MessageSearchEmbedType = {}));
	/**
	* @see {@link https://docs.discord.com/developers/resources/message#search-guild-messages-search-sort-modes}
	*/
	var MessageSearchSortMode;
	(function(MessageSearchSortMode) {
		/**
		* Sort by the message creation time (default)
		*/
		MessageSearchSortMode["Timestamp"] = "timestamp";
		/**
		* Sort by the relevance of the message to the search query
		*/
		MessageSearchSortMode["Relevance"] = "relevance";
	})(MessageSearchSortMode || (exports.MessageSearchSortMode = MessageSearchSortMode = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/monetization.js
var require_monetization$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.SubscriptionStatus = exports.SKUType = exports.SKUFlags = exports.EntitlementType = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/monetization/entitlements#entitlement-object-entitlement-types}
	*/
	var EntitlementType;
	(function(EntitlementType) {
		/**
		* Entitlement was purchased by user
		*/
		EntitlementType[EntitlementType["Purchase"] = 1] = "Purchase";
		/**
		* Entitlement for Discord Nitro subscription
		*/
		EntitlementType[EntitlementType["PremiumSubscription"] = 2] = "PremiumSubscription";
		/**
		* Entitlement was gifted by developer
		*/
		EntitlementType[EntitlementType["DeveloperGift"] = 3] = "DeveloperGift";
		/**
		* Entitlement was purchased by a dev in application test mode
		*/
		EntitlementType[EntitlementType["TestModePurchase"] = 4] = "TestModePurchase";
		/**
		* Entitlement was granted when the SKU was free
		*/
		EntitlementType[EntitlementType["FreePurchase"] = 5] = "FreePurchase";
		/**
		* Entitlement was gifted by another user
		*/
		EntitlementType[EntitlementType["UserGift"] = 6] = "UserGift";
		/**
		* Entitlement was claimed by user for free as a Nitro Subscriber
		*/
		EntitlementType[EntitlementType["PremiumPurchase"] = 7] = "PremiumPurchase";
		/**
		* Entitlement was purchased as an app subscription
		*/
		EntitlementType[EntitlementType["ApplicationSubscription"] = 8] = "ApplicationSubscription";
	})(EntitlementType || (exports.EntitlementType = EntitlementType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/monetization/skus#sku-object-sku-flags}
	*/
	var SKUFlags;
	(function(SKUFlags) {
		/**
		* SKU is available for purchase
		*/
		SKUFlags[SKUFlags["Available"] = 4] = "Available";
		/**
		* Recurring SKU that can be purchased by a user and applied to a single server.
		* Grants access to every user in that server.
		*/
		SKUFlags[SKUFlags["GuildSubscription"] = 128] = "GuildSubscription";
		/**
		* Recurring SKU purchased by a user for themselves. Grants access to the purchasing user in every server.
		*/
		SKUFlags[SKUFlags["UserSubscription"] = 256] = "UserSubscription";
	})(SKUFlags || (exports.SKUFlags = SKUFlags = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/sku#sku-object-sku-types}
	*/
	var SKUType;
	(function(SKUType) {
		/**
		* Durable one-time purchase
		*/
		SKUType[SKUType["Durable"] = 2] = "Durable";
		/**
		* Consumable one-time purchase
		*/
		SKUType[SKUType["Consumable"] = 3] = "Consumable";
		/**
		* Represents a recurring subscription
		*/
		SKUType[SKUType["Subscription"] = 5] = "Subscription";
		/**
		* System-generated group for each Subscription SKU created
		*/
		SKUType[SKUType["SubscriptionGroup"] = 6] = "SubscriptionGroup";
	})(SKUType || (exports.SKUType = SKUType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/subscription#subscription-statuses}
	*/
	var SubscriptionStatus;
	(function(SubscriptionStatus) {
		/**
		* Subscription is active and scheduled to renew.
		*/
		SubscriptionStatus[SubscriptionStatus["Active"] = 0] = "Active";
		/**
		* Subscription is active but will not renew.
		*/
		SubscriptionStatus[SubscriptionStatus["Ending"] = 1] = "Ending";
		/**
		* Subscription is inactive and not being charged.
		*/
		SubscriptionStatus[SubscriptionStatus["Inactive"] = 2] = "Inactive";
	})(SubscriptionStatus || (exports.SubscriptionStatus = SubscriptionStatus = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/oauth2.js
var require_oauth2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/topics/oauth2
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.OAuth2Scopes = void 0;
	var OAuth2Scopes;
	(function(OAuth2Scopes) {
		/**
		* For oauth2 bots, this puts the bot in the user's selected guild by default
		*/
		OAuth2Scopes["Bot"] = "bot";
		/**
		* Allows {@link https://discord.com/developers/docs/resources/user#get-user-connections | `/users/@me/connections`}
		* to return linked third-party accounts
		*
		* @see {@link https://discord.com/developers/docs/resources/user#get-user-connections}
		*/
		OAuth2Scopes["Connections"] = "connections";
		/**
		* Allows your app to see information about the user's DMs and group DMs - requires Discord approval
		*/
		OAuth2Scopes["DMChannelsRead"] = "dm_channels.read";
		/**
		* Enables {@link https://discord.com/developers/docs/resources/user#get-current-user | `/users/@me`} to return an `email`
		*
		* @see {@link https://discord.com/developers/docs/resources/user#get-current-user}
		*/
		OAuth2Scopes["Email"] = "email";
		/**
		* Allows {@link https://discord.com/developers/docs/resources/user#get-current-user | `/users/@me`} without `email`
		*
		* @see {@link https://discord.com/developers/docs/resources/user#get-current-user}
		*/
		OAuth2Scopes["Identify"] = "identify";
		/**
		* Allows {@link https://discord.com/developers/docs/resources/user#get-current-user-guilds | `/users/@me/guilds`}
		* to return basic information about all of a user's guilds
		*
		* @see {@link https://discord.com/developers/docs/resources/user#get-current-user-guilds}
		*/
		OAuth2Scopes["Guilds"] = "guilds";
		/**
		* Allows {@link https://discord.com/developers/docs/resources/guild#add-guild-member | `/guilds/[guild.id]/members/[user.id]`}
		* to be used for joining users to a guild
		*
		* @see {@link https://discord.com/developers/docs/resources/guild#add-guild-member}
		*/
		OAuth2Scopes["GuildsJoin"] = "guilds.join";
		/**
		* Allows /users/\@me/guilds/\{guild.id\}/member to return a user's member information in a guild
		*
		* @see {@link https://discord.com/developers/docs/resources/user#get-current-user-guild-member}
		*/
		OAuth2Scopes["GuildsMembersRead"] = "guilds.members.read";
		/**
		* Allows your app to join users to a group dm
		*
		* @see {@link https://discord.com/developers/docs/resources/channel#group-dm-add-recipient}
		*/
		OAuth2Scopes["GroupDMJoins"] = "gdm.join";
		/**
		* For local rpc server api access, this allows you to read messages from all client channels
		* (otherwise restricted to channels/guilds your app creates)
		*/
		OAuth2Scopes["MessagesRead"] = "messages.read";
		/**
		* Allows your app to update a user's connection and metadata for the app
		*/
		OAuth2Scopes["RoleConnectionsWrite"] = "role_connections.write";
		/**
		* For local rpc server access, this allows you to control a user's local Discord client - requires Discord approval
		*/
		OAuth2Scopes["RPC"] = "rpc";
		/**
		* For local rpc server access, this allows you to update a user's activity - requires Discord approval
		*/
		OAuth2Scopes["RPCActivitiesWrite"] = "rpc.activities.write";
		/**
		* For local rpc server access, this allows you to read a user's voice settings and listen for voice events - requires Discord approval
		*/
		OAuth2Scopes["RPCVoiceRead"] = "rpc.voice.read";
		/**
		* For local rpc server access, this allows you to update a user's voice settings - requires Discord approval
		*/
		OAuth2Scopes["RPCVoiceWrite"] = "rpc.voice.write";
		/**
		* For local rpc server api access, this allows you to receive notifications pushed out to the user - requires Discord approval
		*/
		OAuth2Scopes["RPCNotificationsRead"] = "rpc.notifications.read";
		/**
		* This generates a webhook that is returned in the oauth token response for authorization code grants
		*/
		OAuth2Scopes["WebhookIncoming"] = "webhook.incoming";
		/**
		* Allows your app to connect to voice on user's behalf and see all the voice members - requires Discord approval
		*/
		OAuth2Scopes["Voice"] = "voice";
		/**
		* Allows your app to upload/update builds for a user's applications - requires Discord approval
		*/
		OAuth2Scopes["ApplicationsBuildsUpload"] = "applications.builds.upload";
		/**
		* Allows your app to read build data for a user's applications
		*/
		OAuth2Scopes["ApplicationsBuildsRead"] = "applications.builds.read";
		/**
		* Allows your app to read and update store data (SKUs, store listings, achievements, etc.) for a user's applications
		*/
		OAuth2Scopes["ApplicationsStoreUpdate"] = "applications.store.update";
		/**
		* Allows your app to read entitlements for a user's applications
		*/
		OAuth2Scopes["ApplicationsEntitlements"] = "applications.entitlements";
		/**
		* Allows your app to know a user's friends and implicit relationships - requires Discord approval
		*/
		OAuth2Scopes["RelationshipsRead"] = "relationships.read";
		/**
		* Allows your app to fetch data from a user's "Now Playing/Recently Played" list - requires Discord approval
		*/
		OAuth2Scopes["ActivitiesRead"] = "activities.read";
		/**
		* Allows your app to update a user's activity - requires Discord approval (NOT REQUIRED FOR GAMESDK ACTIVITY MANAGER)
		*
		* @see {@link https://discord.com/developers/docs/game-sdk/activities}
		*/
		OAuth2Scopes["ActivitiesWrite"] = "activities.write";
		/**
		* Allows your app to use Application Commands in a guild
		*
		* @see {@link https://discord.com/developers/docs/interactions/application-commands}
		*/
		OAuth2Scopes["ApplicationsCommands"] = "applications.commands";
		/**
		* Allows your app to update its Application Commands via this bearer token - client credentials grant only
		*
		* @see {@link https://discord.com/developers/docs/interactions/application-commands}
		*/
		OAuth2Scopes["ApplicationsCommandsUpdate"] = "applications.commands.update";
		/**
		* Allows your app to update permissions for its commands using a Bearer token - client credentials grant only
		*
		* @see {@link https://discord.com/developers/docs/interactions/application-commands}
		*/
		OAuth2Scopes["ApplicationCommandsPermissionsUpdate"] = "applications.commands.permissions.update";
	})(OAuth2Scopes || (exports.OAuth2Scopes = OAuth2Scopes = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/permissions.js
var require_permissions = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/topics/permissions
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.RoleFlags = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/topics/permissions#role-object-role-flags}
	*/
	var RoleFlags;
	(function(RoleFlags) {
		/**
		* Role can be selected by members in an onboarding prompt
		*/
		RoleFlags[RoleFlags["InPrompt"] = 1] = "InPrompt";
	})(RoleFlags || (exports.RoleFlags = RoleFlags = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/poll.js
var require_poll = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/resources/poll
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.PollLayoutType = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/poll#layout-type}
	*/
	var PollLayoutType;
	(function(PollLayoutType) {
		/**
		* The, uhm, default layout type
		*/
		PollLayoutType[PollLayoutType["Default"] = 1] = "Default";
	})(PollLayoutType || (exports.PollLayoutType = PollLayoutType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/stageInstance.js
var require_stageInstance = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.StageInstancePrivacyLevel = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/stage-instance#stage-instance-object-privacy-level}
	*/
	var StageInstancePrivacyLevel;
	(function(StageInstancePrivacyLevel) {
		/**
		* The stage instance is visible publicly, such as on stage discovery
		*
		* @deprecated
		* {@link https://github.com/discord/discord-api-docs/pull/4296 | discord-api-docs#4296}
		*/
		StageInstancePrivacyLevel[StageInstancePrivacyLevel["Public"] = 1] = "Public";
		/**
		* The stage instance is visible to only guild members
		*/
		StageInstancePrivacyLevel[StageInstancePrivacyLevel["GuildOnly"] = 2] = "GuildOnly";
	})(StageInstancePrivacyLevel || (exports.StageInstancePrivacyLevel = StageInstancePrivacyLevel = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/sticker.js
var require_sticker = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/resources/sticker
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.StickerFormatType = exports.StickerType = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/sticker#sticker-object-sticker-types}
	*/
	var StickerType;
	(function(StickerType) {
		/**
		* An official sticker in a pack
		*/
		StickerType[StickerType["Standard"] = 1] = "Standard";
		/**
		* A sticker uploaded to a guild for the guild's members
		*/
		StickerType[StickerType["Guild"] = 2] = "Guild";
	})(StickerType || (exports.StickerType = StickerType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/sticker#sticker-object-sticker-format-types}
	*/
	var StickerFormatType;
	(function(StickerFormatType) {
		StickerFormatType[StickerFormatType["PNG"] = 1] = "PNG";
		StickerFormatType[StickerFormatType["APNG"] = 2] = "APNG";
		StickerFormatType[StickerFormatType["Lottie"] = 3] = "Lottie";
		StickerFormatType[StickerFormatType["GIF"] = 4] = "GIF";
	})(StickerFormatType || (exports.StickerFormatType = StickerFormatType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/teams.js
var require_teams = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/topics/teams
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.TeamMemberRole = exports.TeamMemberMembershipState = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/topics/teams#data-models-membership-state-enum}
	*/
	var TeamMemberMembershipState;
	(function(TeamMemberMembershipState) {
		TeamMemberMembershipState[TeamMemberMembershipState["Invited"] = 1] = "Invited";
		TeamMemberMembershipState[TeamMemberMembershipState["Accepted"] = 2] = "Accepted";
	})(TeamMemberMembershipState || (exports.TeamMemberMembershipState = TeamMemberMembershipState = {}));
	/**
	* @see {@link https://discord.com/developers/docs/topics/teams#team-member-roles-team-member-role-types}
	*/
	var TeamMemberRole;
	(function(TeamMemberRole) {
		TeamMemberRole["Admin"] = "admin";
		TeamMemberRole["Developer"] = "developer";
		TeamMemberRole["ReadOnly"] = "read_only";
	})(TeamMemberRole || (exports.TeamMemberRole = TeamMemberRole = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/user.js
var require_user = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/resources/user
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.NameplatePalette = exports.ConnectionVisibility = exports.ConnectionService = exports.UserPremiumType = exports.UserFlags = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/user#user-object-user-flags}
	*/
	var UserFlags;
	(function(UserFlags) {
		/**
		* Discord Employee
		*/
		UserFlags[UserFlags["Staff"] = 1] = "Staff";
		/**
		* Partnered Server Owner
		*/
		UserFlags[UserFlags["Partner"] = 2] = "Partner";
		/**
		* HypeSquad Events Member
		*/
		UserFlags[UserFlags["Hypesquad"] = 4] = "Hypesquad";
		/**
		* Bug Hunter Level 1
		*/
		UserFlags[UserFlags["BugHunterLevel1"] = 8] = "BugHunterLevel1";
		/**
		* @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		UserFlags[UserFlags["MFASMS"] = 16] = "MFASMS";
		/**
		* @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		UserFlags[UserFlags["PremiumPromoDismissed"] = 32] = "PremiumPromoDismissed";
		/**
		* House Bravery Member
		*/
		UserFlags[UserFlags["HypeSquadOnlineHouse1"] = 64] = "HypeSquadOnlineHouse1";
		/**
		* House Brilliance Member
		*/
		UserFlags[UserFlags["HypeSquadOnlineHouse2"] = 128] = "HypeSquadOnlineHouse2";
		/**
		* House Balance Member
		*/
		UserFlags[UserFlags["HypeSquadOnlineHouse3"] = 256] = "HypeSquadOnlineHouse3";
		/**
		* Early Nitro Supporter
		*/
		UserFlags[UserFlags["PremiumEarlySupporter"] = 512] = "PremiumEarlySupporter";
		/**
		* User is a {@link https://discord.com/developers/docs/topics/teams | team}
		*/
		UserFlags[UserFlags["TeamPseudoUser"] = 1024] = "TeamPseudoUser";
		/**
		* @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		UserFlags[UserFlags["HasUnreadUrgentMessages"] = 8192] = "HasUnreadUrgentMessages";
		/**
		* Bug Hunter Level 2
		*/
		UserFlags[UserFlags["BugHunterLevel2"] = 16384] = "BugHunterLevel2";
		/**
		* Verified Bot
		*/
		UserFlags[UserFlags["VerifiedBot"] = 65536] = "VerifiedBot";
		/**
		* Early Verified Bot Developer
		*/
		UserFlags[UserFlags["VerifiedDeveloper"] = 131072] = "VerifiedDeveloper";
		/**
		* Moderator Programs Alumni
		*/
		UserFlags[UserFlags["CertifiedModerator"] = 262144] = "CertifiedModerator";
		/**
		* Bot uses only {@link https://discord.com/developers/docs/interactions/receiving-and-responding#receiving-an-interaction | HTTP interactions} and is shown in the online member list
		*/
		UserFlags[UserFlags["BotHTTPInteractions"] = 524288] = "BotHTTPInteractions";
		/**
		* User has been identified as spammer
		*
		* @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		UserFlags[UserFlags["Spammer"] = 1048576] = "Spammer";
		/**
		* @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		*/
		UserFlags[UserFlags["DisablePremium"] = 2097152] = "DisablePremium";
		/**
		* User is an {@link https://support-dev.discord.com/hc/articles/10113997751447 | Active Developer}
		*
		* @deprecated This user flag is no longer available. See {@link https://support-dev.discord.com/hc/articles/10113997751447-Active-Developer-Badge} for more information.
		*/
		UserFlags[UserFlags["ActiveDeveloper"] = 4194304] = "ActiveDeveloper";
		/**
		* User's account has been {@link https://support.discord.com/hc/articles/6461420677527 | quarantined} based on recent activity
		*
		* @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		* @privateRemarks
		*
		* This value would be `1 << 44`, but bit shifting above `1 << 30` requires bigints
		*/
		UserFlags[UserFlags["Quarantined"] = 17592186044416] = "Quarantined";
		/**
		* @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		* @privateRemarks
		*
		* This value would be `1 << 50`, but bit shifting above `1 << 30` requires bigints
		*/
		UserFlags[UserFlags["Collaborator"] = 0x4000000000000] = "Collaborator";
		/**
		* @unstable This user flag is currently not documented by Discord but has a known value which we will try to keep up to date.
		* @privateRemarks
		*
		* This value would be `1 << 51`, but bit shifting above `1 << 30` requires bigints
		*/
		UserFlags[UserFlags["RestrictedCollaborator"] = 0x8000000000000] = "RestrictedCollaborator";
	})(UserFlags || (exports.UserFlags = UserFlags = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/user#user-object-premium-types}
	*/
	var UserPremiumType;
	(function(UserPremiumType) {
		UserPremiumType[UserPremiumType["None"] = 0] = "None";
		UserPremiumType[UserPremiumType["NitroClassic"] = 1] = "NitroClassic";
		UserPremiumType[UserPremiumType["Nitro"] = 2] = "Nitro";
		UserPremiumType[UserPremiumType["NitroBasic"] = 3] = "NitroBasic";
	})(UserPremiumType || (exports.UserPremiumType = UserPremiumType = {}));
	var ConnectionService;
	(function(ConnectionService) {
		ConnectionService["AmazonMusic"] = "amazon-music";
		ConnectionService["BattleNet"] = "battlenet";
		ConnectionService["Bluesky"] = "bluesky";
		ConnectionService["BungieNet"] = "bungie";
		ConnectionService["Crunchyroll"] = "crunchyroll";
		ConnectionService["Domain"] = "domain";
		ConnectionService["eBay"] = "ebay";
		ConnectionService["EpicGames"] = "epicgames";
		ConnectionService["Facebook"] = "facebook";
		ConnectionService["GitHub"] = "github";
		ConnectionService["Instagram"] = "instagram";
		ConnectionService["LeagueOfLegends"] = "leagueoflegends";
		ConnectionService["Mastodon"] = "mastodon";
		ConnectionService["PayPal"] = "paypal";
		ConnectionService["PlayStationNetwork"] = "playstation";
		ConnectionService["Reddit"] = "reddit";
		ConnectionService["RiotGames"] = "riotgames";
		ConnectionService["Roblox"] = "roblox";
		ConnectionService["Spotify"] = "spotify";
		ConnectionService["Skype"] = "skype";
		ConnectionService["Steam"] = "steam";
		ConnectionService["TikTok"] = "tiktok";
		ConnectionService["Twitch"] = "twitch";
		ConnectionService["X"] = "twitter";
		/**
		* @deprecated This is the old name for {@link ConnectionService.X}
		*/
		ConnectionService["Twitter"] = "twitter";
		ConnectionService["Xbox"] = "xbox";
		ConnectionService["YouTube"] = "youtube";
	})(ConnectionService || (exports.ConnectionService = ConnectionService = {}));
	var ConnectionVisibility;
	(function(ConnectionVisibility) {
		/**
		* Invisible to everyone except the user themselves
		*/
		ConnectionVisibility[ConnectionVisibility["None"] = 0] = "None";
		/**
		* Visible to everyone
		*/
		ConnectionVisibility[ConnectionVisibility["Everyone"] = 1] = "Everyone";
	})(ConnectionVisibility || (exports.ConnectionVisibility = ConnectionVisibility = {}));
	/**
	* Background color of a nameplate.
	*/
	var NameplatePalette;
	(function(NameplatePalette) {
		NameplatePalette["Berry"] = "berry";
		NameplatePalette["BubbleGum"] = "bubble_gum";
		NameplatePalette["Clover"] = "clover";
		NameplatePalette["Cobalt"] = "cobalt";
		NameplatePalette["Crimson"] = "crimson";
		NameplatePalette["Forest"] = "forest";
		NameplatePalette["Lemon"] = "lemon";
		NameplatePalette["Sky"] = "sky";
		NameplatePalette["Teal"] = "teal";
		NameplatePalette["Violet"] = "violet";
		NameplatePalette["White"] = "white";
	})(NameplatePalette || (exports.NameplatePalette = NameplatePalette = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/webhook.js
var require_webhook = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Types extracted from https://discord.com/developers/docs/resources/webhook
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.WebhookType = exports.ApplicationWebhookEventType = exports.ApplicationWebhookType = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/events/webhook-events#webhook-types}
	*/
	var ApplicationWebhookType;
	(function(ApplicationWebhookType) {
		/**
		* PING event sent to verify your Webhook Event URL is active
		*/
		ApplicationWebhookType[ApplicationWebhookType["Ping"] = 0] = "Ping";
		/**
		* Webhook event (details for event in event body object)
		*/
		ApplicationWebhookType[ApplicationWebhookType["Event"] = 1] = "Event";
	})(ApplicationWebhookType || (exports.ApplicationWebhookType = ApplicationWebhookType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/events/webhook-events#event-types}
	*/
	var ApplicationWebhookEventType;
	(function(ApplicationWebhookEventType) {
		/**
		* Sent when an app was authorized by a user to a server or their account
		*/
		ApplicationWebhookEventType["ApplicationAuthorized"] = "APPLICATION_AUTHORIZED";
		/**
		* Sent when an app was deauthorized by a user
		*/
		ApplicationWebhookEventType["ApplicationDeauthorized"] = "APPLICATION_DEAUTHORIZED";
		/**
		* Entitlement was created
		*/
		ApplicationWebhookEventType["EntitlementCreate"] = "ENTITLEMENT_CREATE";
		/**
		* Entitlement was updated
		*/
		ApplicationWebhookEventType["EntitlementUpdate"] = "ENTITLEMENT_UPDATE";
		/**
		* Entitlement was deleted
		*/
		ApplicationWebhookEventType["EntitlementDelete"] = "ENTITLEMENT_DELETE";
		/**
		* User was added to a Quest (currently unavailable)
		*/
		ApplicationWebhookEventType["QuestUserEnrollment"] = "QUEST_USER_ENROLLMENT";
	})(ApplicationWebhookEventType || (exports.ApplicationWebhookEventType = ApplicationWebhookEventType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/resources/webhook#webhook-object-webhook-types}
	*/
	var WebhookType;
	(function(WebhookType) {
		/**
		* Incoming Webhooks can post messages to channels with a generated token
		*/
		WebhookType[WebhookType["Incoming"] = 1] = "Incoming";
		/**
		* Channel Follower Webhooks are internal webhooks used with Channel Following to post new messages into channels
		*/
		WebhookType[WebhookType["ChannelFollower"] = 2] = "ChannelFollower";
		/**
		* Application webhooks are webhooks used with Interactions
		*/
		WebhookType[WebhookType["Application"] = 3] = "Application";
	})(WebhookType || (exports.WebhookType = WebhookType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/payloads/v10/index.js
var require_v10$4 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$4) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$4, p)) __createBinding(exports$4, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_common$2(), exports);
	__exportStar(require_application(), exports);
	__exportStar(require_auditLog(), exports);
	__exportStar(require_autoModeration(), exports);
	__exportStar(require_channel$1(), exports);
	__exportStar(require_gateway(), exports);
	__exportStar(require_guild(), exports);
	__exportStar(require_guildScheduledEvent(), exports);
	__exportStar(require_interactions(), exports);
	__exportStar(require_invite(), exports);
	__exportStar(require_message(), exports);
	__exportStar(require_monetization$1(), exports);
	__exportStar(require_oauth2(), exports);
	__exportStar(require_permissions(), exports);
	__exportStar(require_poll(), exports);
	__exportStar(require_stageInstance(), exports);
	__exportStar(require_sticker(), exports);
	__exportStar(require_teams(), exports);
	__exportStar(require_user(), exports);
	__exportStar(require_webhook(), exports);
}));
//#endregion
//#region node_modules/discord-api-types/utils/internals.js
var require_internals = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.urlSafeCharacters = void 0;
	const pattern = /^[\d%A-Za-z-_]+$/g;
	exports.urlSafeCharacters = { test(input) {
		const result = pattern.test(input);
		pattern.lastIndex = 0;
		return result;
	} };
}));
//#endregion
//#region node_modules/discord-api-types/rest/common.js
var require_common$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Locale = exports.CannotSendMessagesToThisUserErrorCodes = exports.RESTJSONErrorCodes = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes}
	*/
	var RESTJSONErrorCodes;
	(function(RESTJSONErrorCodes) {
		RESTJSONErrorCodes[RESTJSONErrorCodes["GeneralError"] = 0] = "GeneralError";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownAccount"] = 10001] = "UnknownAccount";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownApplication"] = 10002] = "UnknownApplication";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownChannel"] = 10003] = "UnknownChannel";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownGuild"] = 10004] = "UnknownGuild";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownIntegration"] = 10005] = "UnknownIntegration";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownInvite"] = 10006] = "UnknownInvite";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownMember"] = 10007] = "UnknownMember";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownMessage"] = 10008] = "UnknownMessage";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownPermissionOverwrite"] = 10009] = "UnknownPermissionOverwrite";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownProvider"] = 10010] = "UnknownProvider";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownRole"] = 10011] = "UnknownRole";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownToken"] = 10012] = "UnknownToken";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownUser"] = 10013] = "UnknownUser";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownEmoji"] = 10014] = "UnknownEmoji";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownWebhook"] = 10015] = "UnknownWebhook";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownWebhookService"] = 10016] = "UnknownWebhookService";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownSession"] = 10020] = "UnknownSession";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownAsset"] = 10021] = "UnknownAsset";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownBan"] = 10026] = "UnknownBan";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownSKU"] = 10027] = "UnknownSKU";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownStoreListing"] = 10028] = "UnknownStoreListing";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownEntitlement"] = 10029] = "UnknownEntitlement";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownBuild"] = 10030] = "UnknownBuild";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownLobby"] = 10031] = "UnknownLobby";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownBranch"] = 10032] = "UnknownBranch";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownStoreDirectoryLayout"] = 10033] = "UnknownStoreDirectoryLayout";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownRedistributable"] = 10036] = "UnknownRedistributable";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownGiftCode"] = 10038] = "UnknownGiftCode";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownStream"] = 10049] = "UnknownStream";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownPremiumServerSubscribeCooldown"] = 10050] = "UnknownPremiumServerSubscribeCooldown";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownGuildTemplate"] = 10057] = "UnknownGuildTemplate";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownDiscoverableServerCategory"] = 10059] = "UnknownDiscoverableServerCategory";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownSticker"] = 10060] = "UnknownSticker";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownStickerPack"] = 10061] = "UnknownStickerPack";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownInteraction"] = 10062] = "UnknownInteraction";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownApplicationCommand"] = 10063] = "UnknownApplicationCommand";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownVoiceState"] = 10065] = "UnknownVoiceState";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownApplicationCommandPermissions"] = 10066] = "UnknownApplicationCommandPermissions";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownStageInstance"] = 10067] = "UnknownStageInstance";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownGuildMemberVerificationForm"] = 10068] = "UnknownGuildMemberVerificationForm";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownGuildWelcomeScreen"] = 10069] = "UnknownGuildWelcomeScreen";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownGuildScheduledEvent"] = 10070] = "UnknownGuildScheduledEvent";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownGuildScheduledEventUser"] = 10071] = "UnknownGuildScheduledEventUser";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownTag"] = 10087] = "UnknownTag";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnknownSound"] = 10097] = "UnknownSound";
		RESTJSONErrorCodes[RESTJSONErrorCodes["BotsCannotUseThisEndpoint"] = 20001] = "BotsCannotUseThisEndpoint";
		RESTJSONErrorCodes[RESTJSONErrorCodes["OnlyBotsCanUseThisEndpoint"] = 20002] = "OnlyBotsCanUseThisEndpoint";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ExplicitContentCannotBeSentToTheDesiredRecipient"] = 20009] = "ExplicitContentCannotBeSentToTheDesiredRecipient";
		RESTJSONErrorCodes[RESTJSONErrorCodes["NotAuthorizedToPerformThisActionOnThisApplication"] = 20012] = "NotAuthorizedToPerformThisActionOnThisApplication";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ActionCannotBePerformedDueToSlowmodeRateLimit"] = 20016] = "ActionCannotBePerformedDueToSlowmodeRateLimit";
		RESTJSONErrorCodes[RESTJSONErrorCodes["TheMazeIsntMeantForYou"] = 20017] = "TheMazeIsntMeantForYou";
		RESTJSONErrorCodes[RESTJSONErrorCodes["OnlyTheOwnerOfThisAccountCanPerformThisAction"] = 20018] = "OnlyTheOwnerOfThisAccountCanPerformThisAction";
		RESTJSONErrorCodes[RESTJSONErrorCodes["AnnouncementEditLimitExceeded"] = 20022] = "AnnouncementEditLimitExceeded";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UnderMinimumAge"] = 20024] = "UnderMinimumAge";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ChannelWriteRateLimit"] = 20028] = "ChannelWriteRateLimit";
		/**
		* @deprecated Use {@link RESTJSONErrorCodes.ChannelWriteRateLimit} instead
		*/
		RESTJSONErrorCodes[RESTJSONErrorCodes["ChannelSendRateLimit"] = 20028] = "ChannelSendRateLimit";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ServerWriteRateLimit"] = 20029] = "ServerWriteRateLimit";
		/**
		* @deprecated Use {@link RESTJSONErrorCodes.ServerWriteRateLimit} instead
		*/
		RESTJSONErrorCodes[RESTJSONErrorCodes["ServerSendRateLimit"] = 20029] = "ServerSendRateLimit";
		RESTJSONErrorCodes[RESTJSONErrorCodes["StageTopicServerNameServerDescriptionOrChannelNamesContainDisallowedWords"] = 20031] = "StageTopicServerNameServerDescriptionOrChannelNamesContainDisallowedWords";
		RESTJSONErrorCodes[RESTJSONErrorCodes["GuildPremiumSubscriptionLevelTooLow"] = 20035] = "GuildPremiumSubscriptionLevelTooLow";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfGuildsReached"] = 30001] = "MaximumNumberOfGuildsReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfFriendsReached"] = 30002] = "MaximumNumberOfFriendsReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfPinsReachedForTheChannel"] = 30003] = "MaximumNumberOfPinsReachedForTheChannel";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfRecipientsReached"] = 30004] = "MaximumNumberOfRecipientsReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfGuildRolesReached"] = 30005] = "MaximumNumberOfGuildRolesReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfWebhooksReached"] = 30007] = "MaximumNumberOfWebhooksReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfEmojisReached"] = 30008] = "MaximumNumberOfEmojisReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfReactionsReached"] = 30010] = "MaximumNumberOfReactionsReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfGroupDMsReached"] = 30011] = "MaximumNumberOfGroupDMsReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfGuildChannelsReached"] = 30013] = "MaximumNumberOfGuildChannelsReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfAttachmentsInAMessageReached"] = 30015] = "MaximumNumberOfAttachmentsInAMessageReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfInvitesReached"] = 30016] = "MaximumNumberOfInvitesReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfAnimatedEmojisReached"] = 30018] = "MaximumNumberOfAnimatedEmojisReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfServerMembersReached"] = 30019] = "MaximumNumberOfServerMembersReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfServerCategoriesReached"] = 30030] = "MaximumNumberOfServerCategoriesReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["GuildAlreadyHasTemplate"] = 30031] = "GuildAlreadyHasTemplate";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfApplicationCommandsReached"] = 30032] = "MaximumNumberOfApplicationCommandsReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumThreadParticipantsReached"] = 30033] = "MaximumThreadParticipantsReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumDailyApplicationCommandCreatesReached"] = 30034] = "MaximumDailyApplicationCommandCreatesReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfNonGuildMemberBansHasBeenExceeded"] = 30035] = "MaximumNumberOfNonGuildMemberBansHasBeenExceeded";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfBanFetchesHasBeenReached"] = 30037] = "MaximumNumberOfBanFetchesHasBeenReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfUncompletedGuildScheduledEventsReached"] = 30038] = "MaximumNumberOfUncompletedGuildScheduledEventsReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfStickersReached"] = 30039] = "MaximumNumberOfStickersReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfPruneRequestsHasBeenReached"] = 30040] = "MaximumNumberOfPruneRequestsHasBeenReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfGuildWidgetSettingsUpdatesHasBeenReached"] = 30042] = "MaximumNumberOfGuildWidgetSettingsUpdatesHasBeenReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfSoundboardSoundsReached"] = 30045] = "MaximumNumberOfSoundboardSoundsReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfEditsToMessagesOlderThanOneHourReached"] = 30046] = "MaximumNumberOfEditsToMessagesOlderThanOneHourReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfPinnedThreadsInForumHasBeenReached"] = 30047] = "MaximumNumberOfPinnedThreadsInForumHasBeenReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfTagsInForumHasBeenReached"] = 30048] = "MaximumNumberOfTagsInForumHasBeenReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["BitrateIsTooHighForChannelOfThisType"] = 30052] = "BitrateIsTooHighForChannelOfThisType";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfPremiumEmojisReached"] = 30056] = "MaximumNumberOfPremiumEmojisReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfWebhooksPerGuildReached"] = 30058] = "MaximumNumberOfWebhooksPerGuildReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumNumberOfChannelPermissionOverwritesReached"] = 30060] = "MaximumNumberOfChannelPermissionOverwritesReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["TheChannelsForThisGuildAreTooLarge"] = 30061] = "TheChannelsForThisGuildAreTooLarge";
		RESTJSONErrorCodes[RESTJSONErrorCodes["Unauthorized"] = 40001] = "Unauthorized";
		RESTJSONErrorCodes[RESTJSONErrorCodes["VerifyYourAccount"] = 40002] = "VerifyYourAccount";
		RESTJSONErrorCodes[RESTJSONErrorCodes["OpeningDirectMessagesTooFast"] = 40003] = "OpeningDirectMessagesTooFast";
		RESTJSONErrorCodes[RESTJSONErrorCodes["SendMessagesHasBeenTemporarilyDisabled"] = 40004] = "SendMessagesHasBeenTemporarilyDisabled";
		RESTJSONErrorCodes[RESTJSONErrorCodes["RequestEntityTooLarge"] = 40005] = "RequestEntityTooLarge";
		RESTJSONErrorCodes[RESTJSONErrorCodes["FeatureTemporarilyDisabledServerSide"] = 40006] = "FeatureTemporarilyDisabledServerSide";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UserBannedFromThisGuild"] = 40007] = "UserBannedFromThisGuild";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ConnectionHasBeenRevoked"] = 40012] = "ConnectionHasBeenRevoked";
		RESTJSONErrorCodes[RESTJSONErrorCodes["OnlyConsumableSKUsCanBeConsumed"] = 40018] = "OnlyConsumableSKUsCanBeConsumed";
		RESTJSONErrorCodes[RESTJSONErrorCodes["YouCanOnlyDeleteSandboxEntitlements"] = 40019] = "YouCanOnlyDeleteSandboxEntitlements";
		RESTJSONErrorCodes[RESTJSONErrorCodes["TargetUserIsNotConnectedToVoice"] = 40032] = "TargetUserIsNotConnectedToVoice";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ThisMessageWasAlreadyCrossposted"] = 40033] = "ThisMessageWasAlreadyCrossposted";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ApplicationCommandWithThatNameAlreadyExists"] = 40041] = "ApplicationCommandWithThatNameAlreadyExists";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ApplicationInteractionFailedToSend"] = 40043] = "ApplicationInteractionFailedToSend";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotSendAMessageInAForumChannel"] = 40058] = "CannotSendAMessageInAForumChannel";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InteractionHasAlreadyBeenAcknowledged"] = 40060] = "InteractionHasAlreadyBeenAcknowledged";
		RESTJSONErrorCodes[RESTJSONErrorCodes["TagNamesMustBeUnique"] = 40061] = "TagNamesMustBeUnique";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ServiceResourceIsBeingRateLimited"] = 40062] = "ServiceResourceIsBeingRateLimited";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ThereAreNoTagsAvailableThatCanBeSetByNonModerators"] = 40066] = "ThereAreNoTagsAvailableThatCanBeSetByNonModerators";
		RESTJSONErrorCodes[RESTJSONErrorCodes["TagRequiredToCreateAForumPostInThisChannel"] = 40067] = "TagRequiredToCreateAForumPostInThisChannel";
		RESTJSONErrorCodes[RESTJSONErrorCodes["AnEntitlementHasAlreadyBeenGrantedForThisResource"] = 40074] = "AnEntitlementHasAlreadyBeenGrantedForThisResource";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ThisInteractionHasHitTheMaximumNumberOfFollowUpMessages"] = 40094] = "ThisInteractionHasHitTheMaximumNumberOfFollowUpMessages";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CloudflareIsBlockingYourRequest"] = 40333] = "CloudflareIsBlockingYourRequest";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MissingAccess"] = 50001] = "MissingAccess";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidAccountType"] = 50002] = "InvalidAccountType";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotExecuteActionOnDMChannel"] = 50003] = "CannotExecuteActionOnDMChannel";
		RESTJSONErrorCodes[RESTJSONErrorCodes["GuildWidgetDisabled"] = 50004] = "GuildWidgetDisabled";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotEditMessageAuthoredByAnotherUser"] = 50005] = "CannotEditMessageAuthoredByAnotherUser";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotSendAnEmptyMessage"] = 50006] = "CannotSendAnEmptyMessage";
		/**
		* @see {@link RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds} for a similar error code
		*/
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotSendMessagesToThisUser"] = 50007] = "CannotSendMessagesToThisUser";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotSendMessagesInNonTextChannel"] = 50008] = "CannotSendMessagesInNonTextChannel";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ChannelVerificationLevelTooHighForYouToGainAccess"] = 50009] = "ChannelVerificationLevelTooHighForYouToGainAccess";
		RESTJSONErrorCodes[RESTJSONErrorCodes["OAuth2ApplicationDoesNotHaveBot"] = 50010] = "OAuth2ApplicationDoesNotHaveBot";
		RESTJSONErrorCodes[RESTJSONErrorCodes["OAuth2ApplicationLimitReached"] = 50011] = "OAuth2ApplicationLimitReached";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidOAuth2State"] = 50012] = "InvalidOAuth2State";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MissingPermissions"] = 50013] = "MissingPermissions";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidToken"] = 50014] = "InvalidToken";
		RESTJSONErrorCodes[RESTJSONErrorCodes["NoteWasTooLong"] = 50015] = "NoteWasTooLong";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ProvidedTooFewOrTooManyMessagesToDelete"] = 50016] = "ProvidedTooFewOrTooManyMessagesToDelete";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidMFALevel"] = 50017] = "InvalidMFALevel";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MessageCanOnlyBePinnedInTheChannelItWasSentIn"] = 50019] = "MessageCanOnlyBePinnedInTheChannelItWasSentIn";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InviteCodeInvalidOrTaken"] = 50020] = "InviteCodeInvalidOrTaken";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotExecuteActionOnSystemMessage"] = 50021] = "CannotExecuteActionOnSystemMessage";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotExecuteActionOnThisChannelType"] = 50024] = "CannotExecuteActionOnThisChannelType";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidOAuth2AccessToken"] = 50025] = "InvalidOAuth2AccessToken";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MissingRequiredOAuth2Scope"] = 50026] = "MissingRequiredOAuth2Scope";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidWebhookToken"] = 50027] = "InvalidWebhookToken";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidRole"] = 50028] = "InvalidRole";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidRecipients"] = 50033] = "InvalidRecipients";
		RESTJSONErrorCodes[RESTJSONErrorCodes["OneOfTheMessagesProvidedWasTooOldForBulkDelete"] = 50034] = "OneOfTheMessagesProvidedWasTooOldForBulkDelete";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidFormBodyOrContentType"] = 50035] = "InvalidFormBodyOrContentType";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InviteAcceptedToGuildWithoutTheBotBeingIn"] = 50036] = "InviteAcceptedToGuildWithoutTheBotBeingIn";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidActivityAction"] = 50039] = "InvalidActivityAction";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidAPIVersion"] = 50041] = "InvalidAPIVersion";
		RESTJSONErrorCodes[RESTJSONErrorCodes["FileUploadedExceedsMaximumSize"] = 50045] = "FileUploadedExceedsMaximumSize";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidFileUploaded"] = 50046] = "InvalidFileUploaded";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotSelfRedeemThisGift"] = 50054] = "CannotSelfRedeemThisGift";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidGuild"] = 50055] = "InvalidGuild";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidSKU"] = 50057] = "InvalidSKU";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidRequestOrigin"] = 50067] = "InvalidRequestOrigin";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidMessageType"] = 50068] = "InvalidMessageType";
		RESTJSONErrorCodes[RESTJSONErrorCodes["PaymentSourceRequiredToRedeemGift"] = 50070] = "PaymentSourceRequiredToRedeemGift";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotModifyASystemWebhook"] = 50073] = "CannotModifyASystemWebhook";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotDeleteChannelRequiredForCommunityGuilds"] = 50074] = "CannotDeleteChannelRequiredForCommunityGuilds";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotEditStickersWithinMessage"] = 50080] = "CannotEditStickersWithinMessage";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidStickerSent"] = 50081] = "InvalidStickerSent";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidActionOnArchivedThread"] = 50083] = "InvalidActionOnArchivedThread";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidThreadNotificationSettings"] = 50084] = "InvalidThreadNotificationSettings";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ParameterEarlierThanCreation"] = 50085] = "ParameterEarlierThanCreation";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CommunityServerChannelsMustBeTextChannels"] = 50086] = "CommunityServerChannelsMustBeTextChannels";
		RESTJSONErrorCodes[RESTJSONErrorCodes["TheEntityTypeOfTheEventIsDifferentFromTheEntityYouAreTryingToStartTheEventFor"] = 50091] = "TheEntityTypeOfTheEventIsDifferentFromTheEntityYouAreTryingToStartTheEventFor";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ServerNotAvailableInYourLocation"] = 50095] = "ServerNotAvailableInYourLocation";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ServerNeedsMonetizationEnabledToPerformThisAction"] = 50097] = "ServerNeedsMonetizationEnabledToPerformThisAction";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ServerNeedsMoreBoostsToPerformThisAction"] = 50101] = "ServerNeedsMoreBoostsToPerformThisAction";
		RESTJSONErrorCodes[RESTJSONErrorCodes["RequestBodyContainsInvalidJSON"] = 50109] = "RequestBodyContainsInvalidJSON";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ProvidedFileIsInvalid"] = 50110] = "ProvidedFileIsInvalid";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ProvidedFileTypeIsInvalid"] = 50123] = "ProvidedFileTypeIsInvalid";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ProvidedFileDurationExceedsMaximumLength"] = 50124] = "ProvidedFileDurationExceedsMaximumLength";
		RESTJSONErrorCodes[RESTJSONErrorCodes["OwnerCannotBePendingMember"] = 50131] = "OwnerCannotBePendingMember";
		RESTJSONErrorCodes[RESTJSONErrorCodes["OwnershipCannotBeMovedToABotUser"] = 50132] = "OwnershipCannotBeMovedToABotUser";
		RESTJSONErrorCodes[RESTJSONErrorCodes["FailedToResizeAssetBelowTheMaximumSize"] = 50138] = "FailedToResizeAssetBelowTheMaximumSize";
		/**
		* @deprecated This name is incorrect. Use {@link RESTJSONErrorCodes.FailedToResizeAssetBelowTheMaximumSize} instead
		*/
		RESTJSONErrorCodes[RESTJSONErrorCodes["FailedToResizeAssetBelowTheMinimumSize"] = 50138] = "FailedToResizeAssetBelowTheMinimumSize";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotMixSubscriptionAndNonSubscriptionRolesForAnEmoji"] = 50144] = "CannotMixSubscriptionAndNonSubscriptionRolesForAnEmoji";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotConvertBetweenPremiumEmojiAndNormalEmoji"] = 50145] = "CannotConvertBetweenPremiumEmojiAndNormalEmoji";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UploadedFileNotFound"] = 50146] = "UploadedFileNotFound";
		RESTJSONErrorCodes[RESTJSONErrorCodes["SpecifiedEmojiIsInvalid"] = 50151] = "SpecifiedEmojiIsInvalid";
		RESTJSONErrorCodes[RESTJSONErrorCodes["VoiceMessagesDoNotSupportAdditionalContent"] = 50159] = "VoiceMessagesDoNotSupportAdditionalContent";
		RESTJSONErrorCodes[RESTJSONErrorCodes["VoiceMessagesMustHaveASingleAudioAttachment"] = 50160] = "VoiceMessagesMustHaveASingleAudioAttachment";
		RESTJSONErrorCodes[RESTJSONErrorCodes["VoiceMessagesMustHaveSupportingMetadata"] = 50161] = "VoiceMessagesMustHaveSupportingMetadata";
		RESTJSONErrorCodes[RESTJSONErrorCodes["VoiceMessagesCannotBeEdited"] = 50162] = "VoiceMessagesCannotBeEdited";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotDeleteGuildSubscriptionIntegration"] = 50163] = "CannotDeleteGuildSubscriptionIntegration";
		RESTJSONErrorCodes[RESTJSONErrorCodes["YouCannotSendVoiceMessagesInThisChannel"] = 50173] = "YouCannotSendVoiceMessagesInThisChannel";
		RESTJSONErrorCodes[RESTJSONErrorCodes["TheUserAccountMustFirstBeVerified"] = 50178] = "TheUserAccountMustFirstBeVerified";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ProvidedFileDoesNotHaveAValidDuration"] = 50192] = "ProvidedFileDoesNotHaveAValidDuration";
		/**
		* @see {@link RESTJSONErrorCodes.CannotSendMessagesToThisUser} for a similar error code
		*/
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotSendMessagesToThisUserDueToHavingNoMutualGuilds"] = 50278] = "CannotSendMessagesToThisUserDueToHavingNoMutualGuilds";
		RESTJSONErrorCodes[RESTJSONErrorCodes["YouDoNotHavePermissionToSendThisSticker"] = 50600] = "YouDoNotHavePermissionToSendThisSticker";
		RESTJSONErrorCodes[RESTJSONErrorCodes["TwoFactorAuthenticationIsRequired"] = 60003] = "TwoFactorAuthenticationIsRequired";
		RESTJSONErrorCodes[RESTJSONErrorCodes["NoUsersWithDiscordTagExist"] = 80004] = "NoUsersWithDiscordTagExist";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ReactionWasBlocked"] = 90001] = "ReactionWasBlocked";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UserCannotUseBurstReactions"] = 90002] = "UserCannotUseBurstReactions";
		RESTJSONErrorCodes[RESTJSONErrorCodes["IndexNotYetAvailable"] = 11e4] = "IndexNotYetAvailable";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ApplicationNotYetAvailable"] = 110001] = "ApplicationNotYetAvailable";
		RESTJSONErrorCodes[RESTJSONErrorCodes["APIResourceOverloaded"] = 13e4] = "APIResourceOverloaded";
		RESTJSONErrorCodes[RESTJSONErrorCodes["TheStageIsAlreadyOpen"] = 150006] = "TheStageIsAlreadyOpen";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotReplyWithoutPermissionToReadMessageHistory"] = 160002] = "CannotReplyWithoutPermissionToReadMessageHistory";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ThreadAlreadyCreatedForMessage"] = 160004] = "ThreadAlreadyCreatedForMessage";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ThreadLocked"] = 160005] = "ThreadLocked";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumActiveThreads"] = 160006] = "MaximumActiveThreads";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MaximumActiveAnnouncementThreads"] = 160007] = "MaximumActiveAnnouncementThreads";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotForwardMessageWithUnreadableContent"] = 160014] = "CannotForwardMessageWithUnreadableContent";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidJSONForUploadedLottieFile"] = 170001] = "InvalidJSONForUploadedLottieFile";
		RESTJSONErrorCodes[RESTJSONErrorCodes["UploadedLottiesCannotContainRasterizedImages"] = 170002] = "UploadedLottiesCannotContainRasterizedImages";
		RESTJSONErrorCodes[RESTJSONErrorCodes["StickerMaximumFramerateExceeded"] = 170003] = "StickerMaximumFramerateExceeded";
		RESTJSONErrorCodes[RESTJSONErrorCodes["StickerFrameCountExceedsMaximumOf1000Frames"] = 170004] = "StickerFrameCountExceedsMaximumOf1000Frames";
		RESTJSONErrorCodes[RESTJSONErrorCodes["LottieAnimationMaximumDimensionsExceeded"] = 170005] = "LottieAnimationMaximumDimensionsExceeded";
		RESTJSONErrorCodes[RESTJSONErrorCodes["StickerFramerateIsTooSmallOrTooLarge"] = 170006] = "StickerFramerateIsTooSmallOrTooLarge";
		RESTJSONErrorCodes[RESTJSONErrorCodes["StickerAnimationDurationExceedsMaximumOf5Seconds"] = 170007] = "StickerAnimationDurationExceedsMaximumOf5Seconds";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotUpdateAFinishedEvent"] = 18e4] = "CannotUpdateAFinishedEvent";
		RESTJSONErrorCodes[RESTJSONErrorCodes["FailedToCreateStageNeededForStageEvent"] = 180002] = "FailedToCreateStageNeededForStageEvent";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MessageWasBlockedByAutomaticModeration"] = 2e5] = "MessageWasBlockedByAutomaticModeration";
		RESTJSONErrorCodes[RESTJSONErrorCodes["TitleWasBlockedByAutomaticModeration"] = 200001] = "TitleWasBlockedByAutomaticModeration";
		RESTJSONErrorCodes[RESTJSONErrorCodes["WebhooksPostedToForumChannelsMustHaveAThreadNameOrThreadId"] = 220001] = "WebhooksPostedToForumChannelsMustHaveAThreadNameOrThreadId";
		RESTJSONErrorCodes[RESTJSONErrorCodes["WebhooksPostedToForumChannelsCannotHaveBothAThreadNameAndThreadId"] = 220002] = "WebhooksPostedToForumChannelsCannotHaveBothAThreadNameAndThreadId";
		RESTJSONErrorCodes[RESTJSONErrorCodes["WebhooksCanOnlyCreateThreadsInForumChannels"] = 220003] = "WebhooksCanOnlyCreateThreadsInForumChannels";
		RESTJSONErrorCodes[RESTJSONErrorCodes["WebhookServicesCannotBeUsedInForumChannels"] = 220004] = "WebhookServicesCannotBeUsedInForumChannels";
		RESTJSONErrorCodes[RESTJSONErrorCodes["MessageBlockedByHarmfulLinksFilter"] = 24e4] = "MessageBlockedByHarmfulLinksFilter";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotEnableOnboardingRequirementsAreNotMet"] = 35e4] = "CannotEnableOnboardingRequirementsAreNotMet";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotUpdateOnboardingWhileBelowRequirements"] = 350001] = "CannotUpdateOnboardingWhileBelowRequirements";
		RESTJSONErrorCodes[RESTJSONErrorCodes["AccessToFileUploadsHasBeenLimitedForThisGuild"] = 400001] = "AccessToFileUploadsHasBeenLimitedForThisGuild";
		RESTJSONErrorCodes[RESTJSONErrorCodes["FailedToBanUsers"] = 5e5] = "FailedToBanUsers";
		RESTJSONErrorCodes[RESTJSONErrorCodes["PollVotingBlocked"] = 52e4] = "PollVotingBlocked";
		RESTJSONErrorCodes[RESTJSONErrorCodes["PollExpired"] = 520001] = "PollExpired";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidChannelTypeForPollCreation"] = 520002] = "InvalidChannelTypeForPollCreation";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotEditAPollMessage"] = 520003] = "CannotEditAPollMessage";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotUseAnEmojiIncludedWithThePoll"] = 520004] = "CannotUseAnEmojiIncludedWithThePoll";
		RESTJSONErrorCodes[RESTJSONErrorCodes["CannotExpireANonPollMessage"] = 520006] = "CannotExpireANonPollMessage";
		RESTJSONErrorCodes[RESTJSONErrorCodes["ProvisionalAccountsPermissionNotGranted"] = 53e4] = "ProvisionalAccountsPermissionNotGranted";
		RESTJSONErrorCodes[RESTJSONErrorCodes["IdTokenJWTExpired"] = 530001] = "IdTokenJWTExpired";
		RESTJSONErrorCodes[RESTJSONErrorCodes["IdTokenJWTIssuerMismatch"] = 530002] = "IdTokenJWTIssuerMismatch";
		RESTJSONErrorCodes[RESTJSONErrorCodes["IdTokenJWTAudienceMismatch"] = 530003] = "IdTokenJWTAudienceMismatch";
		RESTJSONErrorCodes[RESTJSONErrorCodes["IdTokenJWTIssuedTooLongAgo"] = 530004] = "IdTokenJWTIssuedTooLongAgo";
		RESTJSONErrorCodes[RESTJSONErrorCodes["FailedToGenerateUniqueUsername"] = 530006] = "FailedToGenerateUniqueUsername";
		RESTJSONErrorCodes[RESTJSONErrorCodes["InvalidClientSecret"] = 530007] = "InvalidClientSecret";
	})(RESTJSONErrorCodes || (exports.RESTJSONErrorCodes = RESTJSONErrorCodes = {}));
	/**
	* JSON Error Codes that represent "Cannot send messages to this user".
	* Discord uses two different error codes for this error:
	* - {@link RESTJSONErrorCodes.CannotSendMessagesToThisUser} (50_007)
	* - {@link RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds} (50_278)
	*/
	exports.CannotSendMessagesToThisUserErrorCodes = [RESTJSONErrorCodes.CannotSendMessagesToThisUser, RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds];
	/**
	* @see {@link https://discord.com/developers/docs/reference#locales}
	*/
	var Locale;
	(function(Locale) {
		Locale["Indonesian"] = "id";
		Locale["EnglishUS"] = "en-US";
		Locale["EnglishGB"] = "en-GB";
		Locale["Bulgarian"] = "bg";
		Locale["ChineseCN"] = "zh-CN";
		Locale["ChineseTW"] = "zh-TW";
		Locale["Croatian"] = "hr";
		Locale["Czech"] = "cs";
		Locale["Danish"] = "da";
		Locale["Dutch"] = "nl";
		Locale["Finnish"] = "fi";
		Locale["French"] = "fr";
		Locale["German"] = "de";
		Locale["Greek"] = "el";
		Locale["Hindi"] = "hi";
		Locale["Hungarian"] = "hu";
		Locale["Italian"] = "it";
		Locale["Japanese"] = "ja";
		Locale["Korean"] = "ko";
		Locale["Lithuanian"] = "lt";
		Locale["Norwegian"] = "no";
		Locale["Polish"] = "pl";
		Locale["PortugueseBR"] = "pt-BR";
		Locale["Romanian"] = "ro";
		Locale["Russian"] = "ru";
		Locale["SpanishES"] = "es-ES";
		Locale["SpanishLATAM"] = "es-419";
		Locale["Swedish"] = "sv-SE";
		Locale["Thai"] = "th";
		Locale["Turkish"] = "tr";
		Locale["Ukrainian"] = "uk";
		Locale["Vietnamese"] = "vi";
	})(Locale || (exports.Locale = Locale = {}));
}));
//#endregion
//#region node_modules/discord-api-types/rest/v10/channel.js
var require_channel = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ReactionType = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/channel#get-reactions-reaction-types}
	*/
	var ReactionType;
	(function(ReactionType) {
		ReactionType[ReactionType["Normal"] = 0] = "Normal";
		ReactionType[ReactionType["Burst"] = 1] = "Burst";
		/**
		* @deprecated Use {@link ReactionType.Burst} instead
		*/
		ReactionType[ReactionType["Super"] = 1] = "Super";
	})(ReactionType || (exports.ReactionType = ReactionType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/rest/v10/monetization.js
var require_monetization = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.EntitlementOwnerType = void 0;
	/**
	* @see {@link https://discord.com/developers/docs/resources/entitlement#create-test-entitlement}
	*/
	var EntitlementOwnerType;
	(function(EntitlementOwnerType) {
		EntitlementOwnerType[EntitlementOwnerType["Guild"] = 1] = "Guild";
		EntitlementOwnerType[EntitlementOwnerType["User"] = 2] = "User";
	})(EntitlementOwnerType || (exports.EntitlementOwnerType = EntitlementOwnerType = {}));
}));
//#endregion
//#region node_modules/discord-api-types/rest/v10/index.js
var require_v10$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$3) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$3, p)) __createBinding(exports$3, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.OAuth2Routes = exports.RouteBases = exports.CDNRoutes = exports.ImageFormat = exports.StickerPackApplicationId = exports.Routes = exports.APIVersion = void 0;
	const internals_1 = require_internals();
	__exportStar(require_common$1(), exports);
	__exportStar(require_channel(), exports);
	__exportStar(require_monetization(), exports);
	exports.APIVersion = "10";
	exports.Routes = {
		/**
		* Route for:
		* - GET `/applications/{application.id}/role-connections/metadata`
		* - PUT `/applications/{application.id}/role-connections/metadata`
		*/
		applicationRoleConnectionMetadata(applicationId) {
			return `/applications/${applicationId}/role-connections/metadata`;
		},
		/**
		* Route for:
		* - GET  `/guilds/{guild.id}/auto-moderation/rules`
		* - POST `/guilds/{guild.id}/auto-moderation/rules`
		*/
		guildAutoModerationRules(guildId) {
			return `/guilds/${guildId}/auto-moderation/rules`;
		},
		/**
		* Routes for:
		* - GET    `/guilds/{guild.id}/auto-moderation/rules/{rule.id}`
		* - PATCH  `/guilds/{guild.id}/auto-moderation/rules/{rule.id}`
		* - DELETE `/guilds/{guild.id}/auto-moderation/rules/{rule.id}`
		*/
		guildAutoModerationRule(guildId, ruleId) {
			return `/guilds/${guildId}/auto-moderation/rules/${ruleId}`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/audit-logs`
		*/
		guildAuditLog(guildId) {
			return `/guilds/${guildId}/audit-logs`;
		},
		/**
		* Route for:
		* - GET    `/channels/{channel.id}`
		* - PATCH  `/channels/{channel.id}`
		* - DELETE `/channels/{channel.id}`
		*/
		channel(channelId) {
			return `/channels/${channelId}`;
		},
		/**
		* Route for:
		* - GET  `/channels/{channel.id}/messages`
		* - POST `/channels/{channel.id}/messages`
		*/
		channelMessages(channelId) {
			return `/channels/${channelId}/messages`;
		},
		/**
		* Route for:
		* - GET    `/channels/{channel.id}/messages/{message.id}`
		* - PATCH  `/channels/{channel.id}/messages/{message.id}`
		* - DELETE `/channels/{channel.id}/messages/{message.id}`
		*/
		channelMessage(channelId, messageId) {
			return `/channels/${channelId}/messages/${messageId}`;
		},
		/**
		* Route for:
		* - POST `/channels/{channel.id}/messages/{message.id}/crosspost`
		*/
		channelMessageCrosspost(channelId, messageId) {
			return `/channels/${channelId}/messages/${messageId}/crosspost`;
		},
		/**
		* Route for:
		* - PUT    `/channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me`
		* - DELETE `/channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me`
		*
		* **Note**: You need to URL encode the emoji yourself
		*/
		channelMessageOwnReaction(channelId, messageId, emoji) {
			return `/channels/${channelId}/messages/${messageId}/reactions/${emoji}/@me`;
		},
		/**
		* Route for:
		* - DELETE `/channels/{channel.id}/messages/{message.id}/reactions/{emoji}/{user.id}`
		*
		* **Note**: You need to URL encode the emoji yourself
		*/
		channelMessageUserReaction(channelId, messageId, emoji, userId) {
			return `/channels/${channelId}/messages/${messageId}/reactions/${emoji}/${userId}`;
		},
		/**
		* Route for:
		* - GET    `/channels/{channel.id}/messages/{message.id}/reactions/{emoji}`
		* - DELETE `/channels/{channel.id}/messages/{message.id}/reactions/{emoji}`
		*
		* **Note**: You need to URL encode the emoji yourself
		*/
		channelMessageReaction(channelId, messageId, emoji) {
			return `/channels/${channelId}/messages/${messageId}/reactions/${emoji}`;
		},
		/**
		* Route for:
		* - DELETE `/channels/{channel.id}/messages/{message.id}/reactions`
		*/
		channelMessageAllReactions(channelId, messageId) {
			return `/channels/${channelId}/messages/${messageId}/reactions`;
		},
		/**
		* Route for:
		* - POST `/channels/{channel.id}/messages/bulk-delete`
		*/
		channelBulkDelete(channelId) {
			return `/channels/${channelId}/messages/bulk-delete`;
		},
		/**
		* Route for:
		* - PUT    `/channels/{channel.id}/permissions/{overwrite.id}`
		* - DELETE `/channels/{channel.id}/permissions/{overwrite.id}`
		*/
		channelPermission(channelId, overwriteId) {
			return `/channels/${channelId}/permissions/${overwriteId}`;
		},
		/**
		* Route for:
		* - GET  `/channels/{channel.id}/invites`
		* - POST `/channels/{channel.id}/invites`
		*/
		channelInvites(channelId) {
			return `/channels/${channelId}/invites`;
		},
		/**
		* Route for:
		* - POST `/channels/{channel.id}/followers`
		*/
		channelFollowers(channelId) {
			return `/channels/${channelId}/followers`;
		},
		/**
		* Route for:
		* - POST `/channels/{channel.id}/typing`
		*/
		channelTyping(channelId) {
			return `/channels/${channelId}/typing`;
		},
		/**
		* Route for:
		* - GET `/channels/{channel.id}/messages/pins`
		*/
		channelMessagesPins(channelId) {
			return `/channels/${channelId}/messages/pins`;
		},
		/**
		* Route for:
		* - PUT    `/channels/{channel.id}/messages/pins/{message.id}`
		* - DELETE `/channels/{channel.id}/messages/pins/{message.id}`
		*/
		channelMessagesPin(channelId, messageId) {
			return `/channels/${channelId}/messages/pins/${messageId}`;
		},
		/**
		* Route for:
		* - GET `/channels/{channel.id}/pins`
		*
		* @deprecated Use {@link Routes.channelMessagesPins} instead.
		*/
		channelPins(channelId) {
			return `/channels/${channelId}/pins`;
		},
		/**
		* Route for:
		* - PUT    `/channels/{channel.id}/pins/{message.id}`
		* - DELETE `/channels/{channel.id}/pins/{message.id}`
		*
		* @deprecated Use {@link Routes.channelMessagesPin} instead.
		*/
		channelPin(channelId, messageId) {
			return `/channels/${channelId}/pins/${messageId}`;
		},
		/**
		* Route for:
		* - PUT    `/channels/{channel.id}/recipients/{user.id}`
		* - DELETE `/channels/{channel.id}/recipients/{user.id}`
		*/
		channelRecipient(channelId, userId) {
			return `/channels/${channelId}/recipients/${userId}`;
		},
		/**
		* Route for:
		* - GET  `/guilds/{guild.id}/emojis`
		* - POST `/guilds/{guild.id}/emojis`
		*/
		guildEmojis(guildId) {
			return `/guilds/${guildId}/emojis`;
		},
		/**
		* Route for:
		* - GET    `/guilds/{guild.id}/emojis/{emoji.id}`
		* - PATCH  `/guilds/{guild.id}/emojis/{emoji.id}`
		* - DELETE `/guilds/{guild.id}/emojis/{emoji.id}`
		*/
		guildEmoji(guildId, emojiId) {
			return `/guilds/${guildId}/emojis/${emojiId}`;
		},
		/**
		* Route for:
		* - POST `/guilds`
		*
		* @deprecated {@link https://discord.com/developers/docs/change-log#guild-create-deprecation}
		*/
		guilds() {
			return "/guilds";
		},
		/**
		* Route for:
		* - GET    `/guilds/{guild.id}`
		* - PATCH  `/guilds/{guild.id}`
		* - DELETE `/guilds/{guild.id}` (**deprecated**)
		*/
		guild(guildId) {
			return `/guilds/${guildId}`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/preview`
		*/
		guildPreview(guildId) {
			return `/guilds/${guildId}/preview`;
		},
		/**
		* Route for:
		* - GET   `/guilds/{guild.id}/channels`
		* - POST  `/guilds/{guild.id}/channels`
		* - PATCH `/guilds/{guild.id}/channels`
		*/
		guildChannels(guildId) {
			return `/guilds/${guildId}/channels`;
		},
		/**
		* Route for:
		* - GET    `/guilds/{guild.id}/members/{user.id}`
		* - PUT    `/guilds/{guild.id}/members/{user.id}`
		* - PATCH  `/guilds/{guild.id}/members/@me`
		* - PATCH  `/guilds/{guild.id}/members/{user.id}`
		* - DELETE `/guilds/{guild.id}/members/{user.id}`
		*/
		guildMember(guildId, userId = "@me") {
			return `/guilds/${guildId}/members/${userId}`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/members`
		*/
		guildMembers(guildId) {
			return `/guilds/${guildId}/members`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/members/search`
		*/
		guildMembersSearch(guildId) {
			return `/guilds/${guildId}/members/search`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/messages/search`
		*/
		guildMessagesSearch(guildId) {
			return `/guilds/${guildId}/messages/search`;
		},
		/**
		* Route for:
		* - PATCH `/guilds/{guild.id}/members/@me/nick`
		*
		* @deprecated Use {@link Routes.guildMember} instead.
		*/
		guildCurrentMemberNickname(guildId) {
			return `/guilds/${guildId}/members/@me/nick`;
		},
		/**
		* Route for:
		* - PUT    `/guilds/{guild.id}/members/{user.id}/roles/{role.id}`
		* - DELETE `/guilds/{guild.id}/members/{user.id}/roles/{role.id}`
		*/
		guildMemberRole(guildId, memberId, roleId) {
			return `/guilds/${guildId}/members/${memberId}/roles/${roleId}`;
		},
		/**
		* Route for:
		* - POST `/guilds/{guild.id}/mfa`
		*
		* @deprecated
		*/
		guildMFA(guildId) {
			return `/guilds/${guildId}/mfa`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/bans`
		*/
		guildBans(guildId) {
			return `/guilds/${guildId}/bans`;
		},
		/**
		* Route for:
		* - GET    `/guilds/{guild.id}/bans/{user.id}`
		* - PUT    `/guilds/{guild.id}/bans/{user.id}`
		* - DELETE `/guilds/{guild.id}/bans/{user.id}`
		*/
		guildBan(guildId, userId) {
			return `/guilds/${guildId}/bans/${userId}`;
		},
		/**
		* Route for:
		* - GET   `/guilds/{guild.id}/roles`
		* - POST  `/guilds/{guild.id}/roles`
		* - PATCH `/guilds/{guild.id}/roles`
		*/
		guildRoles(guildId) {
			return `/guilds/${guildId}/roles`;
		},
		/**
		* Route for:
		* - GET    `/guilds/{guild.id}/roles/{role.id}`
		* - PATCH  `/guilds/{guild.id}/roles/{role.id}`
		* - DELETE `/guilds/{guild.id}/roles/{role.id}`
		*/
		guildRole(guildId, roleId) {
			return `/guilds/${guildId}/roles/${roleId}`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/roles/member-counts`
		*/
		guildRoleMemberCounts(guildId) {
			return `/guilds/${guildId}/roles/member-counts`;
		},
		/**
		* Route for:
		* - GET  `/guilds/{guild.id}/prune`
		* - POST `/guilds/{guild.id}/prune`
		*/
		guildPrune(guildId) {
			return `/guilds/${guildId}/prune`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/regions`
		*/
		guildVoiceRegions(guildId) {
			return `/guilds/${guildId}/regions`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/invites`
		*/
		guildInvites(guildId) {
			return `/guilds/${guildId}/invites`;
		},
		/**
		* Route for:
		* - GET  `/guilds/{guild.id}/integrations`
		*/
		guildIntegrations(guildId) {
			return `/guilds/${guildId}/integrations`;
		},
		/**
		* Route for:
		* - DELETE `/guilds/{guild.id}/integrations/{integration.id}`
		*/
		guildIntegration(guildId, integrationId) {
			return `/guilds/${guildId}/integrations/${integrationId}`;
		},
		/**
		* Route for:
		* - GET   `/guilds/{guild.id}/widget`
		* - PATCH `/guilds/{guild.id}/widget`
		*/
		guildWidgetSettings(guildId) {
			return `/guilds/${guildId}/widget`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/widget.json`
		*/
		guildWidgetJSON(guildId) {
			return `/guilds/${guildId}/widget.json`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/vanity-url`
		*/
		guildVanityUrl(guildId) {
			return `/guilds/${guildId}/vanity-url`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/widget.png`
		*/
		guildWidgetImage(guildId) {
			return `/guilds/${guildId}/widget.png`;
		},
		/**
		* Route for:
		* - GET    `/invites/{invite.code}`
		* - DELETE `/invites/{invite.code}`
		*/
		invite(code) {
			return `/invites/${code}`;
		},
		/**
		* Route for:
		* - GET  `/guilds/templates/{template.code}`
		* - POST `/guilds/templates/{template.code}` (**deprecated**)
		*/
		template(code) {
			return `/guilds/templates/${code}`;
		},
		/**
		* Route for:
		* - GET  `/guilds/{guild.id}/templates`
		* - POST `/guilds/{guild.id}/templates`
		*/
		guildTemplates(guildId) {
			return `/guilds/${guildId}/templates`;
		},
		/**
		* Route for:
		* - PUT    `/guilds/{guild.id}/templates/{template.code}`
		* - PATCH  `/guilds/{guild.id}/templates/{template.code}`
		* - DELETE `/guilds/{guild.id}/templates/{template.code}`
		*/
		guildTemplate(guildId, code) {
			return `/guilds/${guildId}/templates/${code}`;
		},
		/**
		* Route for:
		* - GET `/channels/{channel.id}/polls/{message.id}/answers/{answer_id}`
		*/
		pollAnswerVoters(channelId, messageId, answerId) {
			return `/channels/${channelId}/polls/${messageId}/answers/${answerId}`;
		},
		/**
		* Route for:
		* - POST `/channels/{channel.id}/polls/{message.id}/expire`
		*/
		expirePoll(channelId, messageId) {
			return `/channels/${channelId}/polls/${messageId}/expire`;
		},
		/**
		* Route for:
		* - POST `/channels/{channel.id}/threads`
		* - POST `/channels/{channel.id}/messages/{message.id}/threads`
		*/
		threads(parentId, messageId) {
			const parts = [
				"",
				"channels",
				parentId
			];
			if (messageId) parts.push("messages", messageId);
			parts.push("threads");
			return parts.join("/");
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/threads/active`
		*/
		guildActiveThreads(guildId) {
			return `/guilds/${guildId}/threads/active`;
		},
		/**
		* Route for:
		* - GET `/channels/{channel.id}/threads/archived/public`
		* - GET `/channels/{channel.id}/threads/archived/private`
		*/
		channelThreads(channelId, archivedStatus) {
			return `/channels/${channelId}/threads/archived/${archivedStatus}`;
		},
		/**
		* Route for:
		* - GET `/channels/{channel.id}/users/@me/threads/archived/private`
		*/
		channelJoinedArchivedThreads(channelId) {
			return `/channels/${channelId}/users/@me/threads/archived/private`;
		},
		/**
		* Route for:
		* - GET    `/channels/{thread.id}/thread-members`
		* - GET    `/channels/{thread.id}/thread-members/{user.id}`
		* - PUT    `/channels/{thread.id}/thread-members/@me`
		* - PUT    `/channels/{thread.id}/thread-members/{user.id}`
		* - DELETE `/channels/{thread.id}/thread-members/@me`
		* - DELETE `/channels/{thread.id}/thread-members/{user.id}`
		*/
		threadMembers(threadId, userId) {
			const parts = [
				"",
				"channels",
				threadId,
				"thread-members"
			];
			if (userId) parts.push(userId);
			return parts.join("/");
		},
		/**
		* Route for:
		* - GET   `/users/@me`
		* - GET   `/users/{user.id}`
		* - PATCH `/users/@me`
		*
		* @param userId - The user ID, defaulted to `@me`
		*/
		user(userId = "@me") {
			return `/users/${userId}`;
		},
		/**
		* Route for:
		* - GET `/users/@me/applications/{application.id}/role-connection`
		* - PUT `/users/@me/applications/{application.id}/role-connection`
		*/
		userApplicationRoleConnection(applicationId) {
			return `/users/@me/applications/${applicationId}/role-connection`;
		},
		/**
		* Route for:
		* - GET `/users/@me/guilds`
		*/
		userGuilds() {
			return `/users/@me/guilds`;
		},
		/**
		* Route for:
		* - GET `/users/@me/guilds/{guild.id}/member`
		*/
		userGuildMember(guildId) {
			return `/users/@me/guilds/${guildId}/member`;
		},
		/**
		* Route for:
		* - DELETE `/users/@me/guilds/{guild.id}`
		*/
		userGuild(guildId) {
			return `/users/@me/guilds/${guildId}`;
		},
		/**
		* Route for:
		* - POST `/users/@me/channels`
		*/
		userChannels() {
			return `/users/@me/channels`;
		},
		/**
		* Route for:
		* - GET `/users/@me/connections`
		*/
		userConnections() {
			return `/users/@me/connections`;
		},
		/**
		* Route for:
		* - GET `/voice/regions`
		*/
		voiceRegions() {
			return `/voice/regions`;
		},
		/**
		* Route for:
		* - GET  `/channels/{channel.id}/webhooks`
		* - POST `/channels/{channel.id}/webhooks`
		*/
		channelWebhooks(channelId) {
			return `/channels/${channelId}/webhooks`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/webhooks`
		*/
		guildWebhooks(guildId) {
			return `/guilds/${guildId}/webhooks`;
		},
		/**
		* Route for:
		* - GET    `/webhooks/{webhook.id}`
		* - GET    `/webhooks/{webhook.id}/{webhook.token}`
		* - PATCH  `/webhooks/{webhook.id}`
		* - PATCH  `/webhooks/{webhook.id}/{webhook.token}`
		* - DELETE `/webhooks/{webhook.id}`
		* - DELETE `/webhooks/{webhook.id}/{webhook.token}`
		* - POST   `/webhooks/{webhook.id}/{webhook.token}`
		*
		* - POST   `/webhooks/{application.id}/{interaction.token}`
		*/
		webhook(webhookId, webhookToken) {
			const parts = [
				"",
				"webhooks",
				webhookId
			];
			if (webhookToken) parts.push(webhookToken);
			return parts.join("/");
		},
		/**
		* Route for:
		* - GET    `/webhooks/{webhook.id}/{webhook.token}/messages/@original`
		* - GET    `/webhooks/{webhook.id}/{webhook.token}/messages/{message.id}`
		* - PATCH  `/webhooks/{webhook.id}/{webhook.token}/messages/@original`
		* - PATCH  `/webhooks/{webhook.id}/{webhook.token}/messages/{message.id}`
		* - DELETE `/webhooks/{webhook.id}/{webhook.token}/messages/@original`
		* - DELETE `/webhooks/{webhook.id}/{webhook.token}/messages/{message.id}`
		*
		* - PATCH  `/webhooks/{application.id}/{interaction.token}/messages/@original`
		* - PATCH  `/webhooks/{application.id}/{interaction.token}/messages/{message.id}`
		* - DELETE `/webhooks/{application.id}/{interaction.token}/messages/{message.id}`
		*/
		webhookMessage(webhookId, webhookToken, messageId = "@original") {
			return `/webhooks/${webhookId}/${webhookToken}/messages/${messageId}`;
		},
		/**
		* Route for:
		* - POST `/webhooks/{webhook.id}/{webhook.token}/github`
		* - POST `/webhooks/{webhook.id}/{webhook.token}/slack`
		*/
		webhookPlatform(webhookId, webhookToken, platform) {
			return `/webhooks/${webhookId}/${webhookToken}/${platform}`;
		},
		/**
		* Route for:
		* - GET `/gateway`
		*/
		gateway() {
			return `/gateway`;
		},
		/**
		* Route for:
		* - GET `/gateway/bot`
		*/
		gatewayBot() {
			return `/gateway/bot`;
		},
		/**
		* Route for:
		* - GET `/oauth2/applications/@me`
		*/
		oauth2CurrentApplication() {
			return `/oauth2/applications/@me`;
		},
		/**
		* Route for:
		* - GET `/oauth2/@me`
		*/
		oauth2CurrentAuthorization() {
			return `/oauth2/@me`;
		},
		/**
		* Route for:
		* - GET `/oauth2/authorize`
		*/
		oauth2Authorization() {
			return `/oauth2/authorize`;
		},
		/**
		* Route for:
		* - POST `/oauth2/token`
		*/
		oauth2TokenExchange() {
			return `/oauth2/token`;
		},
		/**
		* Route for:
		* - POST `/oauth2/token/revoke`
		*/
		oauth2TokenRevocation() {
			return `/oauth2/token/revoke`;
		},
		/**
		* Route for:
		* - GET  `/applications/{application.id}/commands`
		* - PUT  `/applications/{application.id}/commands`
		* - POST `/applications/{application.id}/commands`
		*/
		applicationCommands(applicationId) {
			return `/applications/${applicationId}/commands`;
		},
		/**
		* Route for:
		* - GET    `/applications/{application.id}/commands/{command.id}`
		* - PATCH  `/applications/{application.id}/commands/{command.id}`
		* - DELETE `/applications/{application.id}/commands/{command.id}`
		*/
		applicationCommand(applicationId, commandId) {
			return `/applications/${applicationId}/commands/${commandId}`;
		},
		/**
		* Route for:
		* - GET  `/applications/{application.id}/guilds/{guild.id}/commands`
		* - PUT  `/applications/{application.id}/guilds/{guild.id}/commands`
		* - POST `/applications/{application.id}/guilds/{guild.id}/commands`
		*/
		applicationGuildCommands(applicationId, guildId) {
			return `/applications/${applicationId}/guilds/${guildId}/commands`;
		},
		/**
		* Route for:
		* - GET    `/applications/{application.id}/guilds/{guild.id}/commands/{command.id}`
		* - PATCH  `/applications/{application.id}/guilds/{guild.id}/commands/{command.id}`
		* - DELETE `/applications/{application.id}/guilds/{guild.id}/commands/{command.id}`
		*/
		applicationGuildCommand(applicationId, guildId, commandId) {
			return `/applications/${applicationId}/guilds/${guildId}/commands/${commandId}`;
		},
		/**
		* Route for:
		* - POST `/interactions/{interaction.id}/{interaction.token}/callback`
		*/
		interactionCallback(interactionId, interactionToken) {
			return `/interactions/${interactionId}/${interactionToken}/callback`;
		},
		/**
		* Route for:
		* - GET   `/guilds/{guild.id}/member-verification`
		* - PATCH `/guilds/{guild.id}/member-verification`
		*
		* @unstable https://github.com/discord/discord-api-docs/pull/2547
		*/
		guildMemberVerification(guildId) {
			return `/guilds/${guildId}/member-verification`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/voice-states/@me`
		* - GET `/guilds/{guild.id}/voice-states/{user.id}`
		* - PATCH `/guilds/{guild.id}/voice-states/@me`
		* - PATCH `/guilds/{guild.id}/voice-states/{user.id}`
		*/
		guildVoiceState(guildId, userId = "@me") {
			return `/guilds/${guildId}/voice-states/${userId}`;
		},
		/**
		* Route for:
		* - GET `/applications/{application.id}/guilds/{guild.id}/commands/permissions`
		* - PUT `/applications/{application.id}/guilds/{guild.id}/commands/permissions`
		*/
		guildApplicationCommandsPermissions(applicationId, guildId) {
			return `/applications/${applicationId}/guilds/${guildId}/commands/permissions`;
		},
		/**
		* Route for:
		* - GET `/applications/{application.id}/guilds/{guild.id}/commands/{command.id}/permissions`
		* - PUT `/applications/{application.id}/guilds/{guild.id}/commands/{command.id}/permissions`
		*/
		applicationCommandPermissions(applicationId, guildId, commandId) {
			return `/applications/${applicationId}/guilds/${guildId}/commands/${commandId}/permissions`;
		},
		/**
		* Route for:
		* - GET   `/guilds/{guild.id}/welcome-screen`
		* - PATCH `/guilds/{guild.id}/welcome-screen`
		*/
		guildWelcomeScreen(guildId) {
			return `/guilds/${guildId}/welcome-screen`;
		},
		/**
		* Route for:
		* - POST `/stage-instances`
		*/
		stageInstances() {
			return `/stage-instances`;
		},
		/**
		* Route for:
		* - GET `/stage-instances/{channel.id}`
		* - PATCH `/stage-instances/{channel.id}`
		* - DELETE `/stage-instances/{channel.id}`
		*/
		stageInstance(channelId) {
			return `/stage-instances/${channelId}`;
		},
		/**
		* Route for:
		* - GET `/stickers/{sticker.id}`
		*/
		sticker(stickerId) {
			return `/stickers/${stickerId}`;
		},
		/**
		* Route for:
		* - GET `/sticker-packs`
		*/
		stickerPacks() {
			return "/sticker-packs";
		},
		/**
		* Route for:
		* - GET `/sticker-packs/{pack.id}`
		*/
		stickerPack(packId) {
			return `/sticker-packs/${packId}`;
		},
		/**
		* Route for:
		* - GET `/sticker-packs`
		*
		* @deprecated Use {@link Routes.stickerPacks} instead.
		*/
		nitroStickerPacks() {
			return "/sticker-packs";
		},
		/**
		* Route for:
		* - GET  `/guilds/{guild.id}/stickers`
		* - POST `/guilds/{guild.id}/stickers`
		*/
		guildStickers(guildId) {
			return `/guilds/${guildId}/stickers`;
		},
		/**
		* Route for:
		* - GET    `/guilds/{guild.id}/stickers/{sticker.id}`
		* - PATCH  `/guilds/{guild.id}/stickers/{sticker.id}`
		* - DELETE `/guilds/{guild.id}/stickers/{sticker.id}`
		*/
		guildSticker(guildId, stickerId) {
			return `/guilds/${guildId}/stickers/${stickerId}`;
		},
		/**
		* Route for:
		* - GET  `/guilds/{guild.id}/scheduled-events`
		* - POST `/guilds/{guild.id}/scheduled-events`
		*/
		guildScheduledEvents(guildId) {
			return `/guilds/${guildId}/scheduled-events`;
		},
		/**
		* Route for:
		* - GET  `/guilds/{guild.id}/scheduled-events/{guildScheduledEvent.id}`
		* - PATCH `/guilds/{guild.id}/scheduled-events/{guildScheduledEvent.id}`
		* - DELETE `/guilds/{guild.id}/scheduled-events/{guildScheduledEvent.id}`
		*/
		guildScheduledEvent(guildId, guildScheduledEventId) {
			return `/guilds/${guildId}/scheduled-events/${guildScheduledEventId}`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/scheduled-events/{guildScheduledEvent.id}/users`
		*/
		guildScheduledEventUsers(guildId, guildScheduledEventId) {
			return `/guilds/${guildId}/scheduled-events/${guildScheduledEventId}/users`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/onboarding`
		* - PUT `/guilds/{guild.id}/onboarding`
		*/
		guildOnboarding(guildId) {
			return `/guilds/${guildId}/onboarding`;
		},
		/**
		* Route for:
		* - PUT `/guilds/${guild.id}/incident-actions`
		*/
		guildIncidentActions(guildId) {
			return `/guilds/${guildId}/incident-actions`;
		},
		/**
		* Route for:
		* - GET `/applications/@me`
		* - PATCH `/applications/@me`
		*/
		currentApplication() {
			return "/applications/@me";
		},
		/**
		* Route for:
		* - GET `/applications/{application.id}/activity-instances/{instance_id}`
		*/
		applicationActivityInstance(applicationId, instanceId) {
			return `/applications/${applicationId}/activity-instances/${instanceId}`;
		},
		/**
		* Route for:
		* - GET `/applications/{application.id}/entitlements`
		* - POST `/applications/{application.id}/entitlements`
		*/
		entitlements(applicationId) {
			return `/applications/${applicationId}/entitlements`;
		},
		/**
		* Route for:
		* - GET `/applications/{application.id}/entitlements/{entitlement.id}`
		* - DELETE `/applications/{application.id}/entitlements/{entitlement.id}`
		*/
		entitlement(applicationId, entitlementId) {
			return `/applications/${applicationId}/entitlements/${entitlementId}`;
		},
		/**
		* Route for:
		* - GET `/applications/{application.id}/skus`
		*/
		skus(applicationId) {
			return `/applications/${applicationId}/skus`;
		},
		/**
		* Route for:
		* - POST `/guilds/{guild.id}/bulk-ban`
		*/
		guildBulkBan(guildId) {
			return `/guilds/${guildId}/bulk-ban`;
		},
		/**
		* Route for:
		* - POST `/applications/{application.id}/entitlements/{entitlement.id}/consume`
		*/
		consumeEntitlement(applicationId, entitlementId) {
			return `/applications/${applicationId}/entitlements/${entitlementId}/consume`;
		},
		/**
		* Route for:
		* - GET `/applications/{application.id}/emojis`
		* - POST `/applications/{application.id}/emojis`
		*/
		applicationEmojis(applicationId) {
			return `/applications/${applicationId}/emojis`;
		},
		/**
		* Route for:
		* - GET `/applications/{application.id}/emojis/{emoji.id}`
		* - PATCH `/applications/{application.id}/emojis/{emoji.id}`
		* - DELETE `/applications/{application.id}/emojis/{emoji.id}`
		*/
		applicationEmoji(applicationId, emojiId) {
			return `/applications/${applicationId}/emojis/${emojiId}`;
		},
		/**
		* Route for:
		* - GET `/skus/{sku.id}/subscriptions`
		*/
		skuSubscriptions(skuId) {
			return `/skus/${skuId}/subscriptions`;
		},
		/**
		* Route for:
		* - GET `/skus/{sku.id}/subscriptions/{subscription.id}`
		*/
		skuSubscription(skuId, subscriptionId) {
			return `/skus/${skuId}/subscriptions/${subscriptionId}`;
		},
		/**
		* Route for:
		* - POST `/channels/{channel.id}/send-soundboard-sound`
		*/
		sendSoundboardSound(channelId) {
			return `/channels/${channelId}/send-soundboard-sound`;
		},
		/**
		* Route for:
		* - GET `/soundboard-default-sounds`
		*/
		soundboardDefaultSounds() {
			return "/soundboard-default-sounds";
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/soundboard-sounds`
		* - POST `/guilds/{guild.id}/soundboard-sounds`
		*/
		guildSoundboardSounds(guildId) {
			return `/guilds/${guildId}/soundboard-sounds`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/soundboard-sounds/{sound.id}`
		* - PATCH `/guilds/{guild.id}/soundboard-sounds/{sound.id}`
		* - DELETE `/guilds/{guild.id}/soundboard-sounds/{sound.id}`
		*/
		guildSoundboardSound(guildId, soundId) {
			return `/guilds/${guildId}/soundboard-sounds/${soundId}`;
		}
	};
	for (const [key, fn] of Object.entries(exports.Routes)) exports.Routes[key] = ((...args) => {
		const escaped = args.map((arg) => {
			if (arg) {
				if (internals_1.urlSafeCharacters.test(String(arg))) return arg;
				return encodeURIComponent(arg);
			}
			return arg;
		});
		return fn.call(null, ...escaped);
	});
	Object.freeze(exports.Routes);
	exports.StickerPackApplicationId = "710982414301790216";
	var ImageFormat;
	(function(ImageFormat) {
		ImageFormat["JPEG"] = "jpeg";
		ImageFormat["PNG"] = "png";
		ImageFormat["WebP"] = "webp";
		ImageFormat["GIF"] = "gif";
		ImageFormat["Lottie"] = "json";
	})(ImageFormat || (exports.ImageFormat = ImageFormat = {}));
	exports.CDNRoutes = {
		/**
		* Route for:
		* - GET `/emojis/{emoji.id}.{png|jpeg|webp|gif}`
		*
		* As this route supports GIFs, the hash will begin with `a_` if it is available in GIF format
		*
		* This route supports the extensions: PNG, JPEG, WebP, GIF
		*/
		emoji(emojiId, format) {
			return `/emojis/${emojiId}.${format}`;
		},
		/**
		* Route for:
		* - GET `/icons/{guild.id}/{guild.icon}.{png|jpeg|webp|gif}`
		*
		* As this route supports GIFs, the hash will begin with `a_` if it is available in GIF format
		*
		* This route supports the extensions: PNG, JPEG, WebP, GIF
		*/
		guildIcon(guildId, guildIcon, format) {
			return `/icons/${guildId}/${guildIcon}.${format}`;
		},
		/**
		* Route for:
		* - GET `/splashes/{guild.id}/{guild.splash}.{png|jpeg|webp}`
		*
		* This route supports the extensions: PNG, JPEG, WebP
		*/
		guildSplash(guildId, guildSplash, format) {
			return `/splashes/${guildId}/${guildSplash}.${format}`;
		},
		/**
		* Route for:
		* - GET `/discovery-splashes/{guild.id}/{guild.discovery_splash}.{png|jpeg|webp}`
		*
		* This route supports the extensions: PNG, JPEG, WebP
		*/
		guildDiscoverySplash(guildId, guildDiscoverySplash, format) {
			return `/discovery-splashes/${guildId}/${guildDiscoverySplash}.${format}`;
		},
		/**
		* Route for:
		* - GET `/banners/{guild.id}/{guild.banner}.{png|jpeg|webp|gif}`
		*
		* As this route supports GIFs, the hash will begin with `a_` if it is available in GIF format
		*
		* This route supports the extensions: PNG, JPEG, WebP, GIF
		*/
		guildBanner(guildId, guildBanner, format) {
			return `/banners/${guildId}/${guildBanner}.${format}`;
		},
		/**
		* Route for:
		* - GET `/banners/{user.id}/{user.banner}.{png|jpeg|webp|gif}`
		*
		* As this route supports GIFs, the hash will begin with `a_` if it is available in GIF format
		*
		* This route supports the extensions: PNG, JPEG, WebP, GIF
		*/
		userBanner(userId, userBanner, format) {
			return `/banners/${userId}/${userBanner}.${format}`;
		},
		/**
		* Route for:
		* - GET `/embed/avatars/{index}.png`
		*
		* The value for `index` parameter depends on whether the user is {@link https://discord.com/developers/docs/change-log#unique-usernames-on-discord | migrated to the new username system}.
		* For users on the new username system, `index` will be `(user.id >> 22) % 6`.
		* For users on the legacy username system, `index` will be `user.discriminator % 5`.
		*
		* This route supports the extension: PNG
		*/
		defaultUserAvatar(index) {
			return `/embed/avatars/${index}.png`;
		},
		/**
		* Route for:
		* - GET `/avatars/{user.id}/{user.avatar}.{png|jpeg|webp|gif}`
		*
		* As this route supports GIFs, the hash will begin with `a_` if it is available in GIF format
		*
		* This route supports the extensions: PNG, JPEG, WebP, GIF
		*/
		userAvatar(userId, userAvatar, format) {
			return `/avatars/${userId}/${userAvatar}.${format}`;
		},
		/**
		* Route for:
		* - GET `/guilds/{guild.id}/users/{user.id}/avatars/{guild_member.avatar}.{png|jpeg|webp|gif}`
		*
		* As this route supports GIFs, the hash will begin with `a_` if it is available in GIF format
		*
		* This route supports the extensions: PNG, JPEG, WebP, GIF
		*/
		guildMemberAvatar(guildId, userId, memberAvatar, format) {
			return `/guilds/${guildId}/users/${userId}/avatars/${memberAvatar}.${format}`;
		},
		/**
		* Route for:
		* - GET `/avatar-decorations/{user.id}/{user.avatar_decoration}.png`
		*
		* This route supports the extension: PNG
		*
		* @deprecated Use {@link CDNRoutes.avatarDecoration} instead.
		*/
		userAvatarDecoration(userId, userAvatarDecoration) {
			return `/avatar-decorations/${userId}/${userAvatarDecoration}.png`;
		},
		/**
		* Route for:
		* - GET `/avatar-decoration-presets/{avatar_decoration_data_asset}.png`
		*
		* This route supports the extension: PNG
		*/
		avatarDecoration(avatarDecorationDataAsset) {
			return `/avatar-decoration-presets/${avatarDecorationDataAsset}.png`;
		},
		/**
		* Route for:
		* - GET `/app-icons/{application.id}/{application.icon}.{png|jpeg|webp}`
		*
		* This route supports the extensions: PNG, JPEG, WebP
		*/
		applicationIcon(applicationId, applicationIcon, format) {
			return `/app-icons/${applicationId}/${applicationIcon}.${format}`;
		},
		/**
		* Route for:
		* - GET `/app-icons/{application.id}/{application.cover_image}.{png|jpeg|webp}`
		*
		* This route supports the extensions: PNG, JPEG, WebP
		*/
		applicationCover(applicationId, applicationCoverImage, format) {
			return `/app-icons/${applicationId}/${applicationCoverImage}.${format}`;
		},
		/**
		* Route for:
		* - GET `/app-assets/{application.id}/{application.asset_id}.{png|jpeg|webp}`
		*
		* This route supports the extensions: PNG, JPEG, WebP
		*/
		applicationAsset(applicationId, applicationAssetId, format) {
			return `/app-assets/${applicationId}/${applicationAssetId}.${format}`;
		},
		/**
		* Route for:
		* - GET `/app-assets/{application.id}/achievements/{achievement.id}/icons/{achievement.icon}.{png|jpeg|webp}`
		*
		* This route supports the extensions: PNG, JPEG, WebP
		*/
		achievementIcon(applicationId, achievementId, achievementIconHash, format) {
			return `/app-assets/${applicationId}/achievements/${achievementId}/icons/${achievementIconHash}.${format}`;
		},
		/**
		* Route for:
		* - GET `/app-assets/710982414301790216/store/{sticker_pack.banner.asset_id}.{png|jpeg|webp}`
		*
		* This route supports the extensions: PNG, JPEG, WebP
		*/
		stickerPackBanner(stickerPackBannerAssetId, format) {
			return `/app-assets/${exports.StickerPackApplicationId}/store/${stickerPackBannerAssetId}.${format}`;
		},
		/**
		* Route for:
		* - GET `/app-assets/${application.id}/store/${asset.id}.{png|jpeg|webp}}`
		*
		* This route supports the extensions: PNG, JPEG, WebP
		*/
		storePageAsset(applicationId, assetId, format = ImageFormat.PNG) {
			return `/app-assets/${applicationId}/store/${assetId}.${format}`;
		},
		/**
		* Route for:
		* - GET `/team-icons/{team.id}/{team.icon}.{png|jpeg|webp}`
		*
		* This route supports the extensions: PNG, JPEG, WebP
		*/
		teamIcon(teamId, teamIcon, format) {
			return `/team-icons/${teamId}/${teamIcon}.${format}`;
		},
		/**
		* Route for:
		* - GET `/stickers/{sticker.id}.{png|json}`
		*
		* This route supports the extensions: PNG, Lottie, GIF
		*/
		sticker(stickerId, format) {
			return `/stickers/${stickerId}.${format}`;
		},
		/**
		* Route for:
		* - GET `/role-icons/{role.id}/{role.icon}.{png|jpeg|webp}`
		*
		* This route supports the extensions: PNG, JPEG, WebP
		*/
		roleIcon(roleId, roleIcon, format) {
			return `/role-icons/${roleId}/${roleIcon}.${format}`;
		},
		/**
		* Route for:
		* - GET `/guild-events/{guild_scheduled_event.id}/{guild_scheduled_event.image}.{png|jpeg|webp}`
		*
		* This route supports the extensions: PNG, JPEG, WebP
		*/
		guildScheduledEventCover(guildScheduledEventId, guildScheduledEventCoverImage, format) {
			return `/guild-events/${guildScheduledEventId}/${guildScheduledEventCoverImage}.${format}`;
		},
		/**
		* Route for:
		* - GET `/guilds/${guild.id}/users/${user.id}/banners/${guild_member.banner}.{png|jpeg|webp|gif}`
		*
		* This route supports the extensions: PNG, JPEG, WebP, GIF
		*/
		guildMemberBanner(guildId, userId, guildMemberBanner, format) {
			return `/guilds/${guildId}/users/${userId}/banners/${guildMemberBanner}.${format}`;
		},
		/**
		* Route for:
		* - GET `/soundboard-sounds/${sound.id}`
		*/
		soundboardSound(soundId) {
			return `/soundboard-sounds/${soundId}`;
		},
		/**
		* Route for:
		* - GET `/guild-tag-badges/{guild.id}/{badge}.{png|jpeg|webp}`
		*
		* This route supports the extensions: PNG, JPEG, WebP
		*/
		guildTagBadge(guildId, guildTagBadge, format) {
			return `/guild-tag-badges/${guildId}/${guildTagBadge}.${format}`;
		}
	};
	for (const [key, fn] of Object.entries(exports.CDNRoutes)) exports.CDNRoutes[key] = ((...args) => {
		const escaped = args.map((arg) => {
			if (arg) {
				if (internals_1.urlSafeCharacters.test(String(arg))) return arg;
				return encodeURIComponent(arg);
			}
			return arg;
		});
		return fn.call(null, ...escaped);
	});
	Object.freeze(exports.CDNRoutes);
	exports.RouteBases = {
		api: `https://discord.com/api/v${exports.APIVersion}`,
		cdn: "https://cdn.discordapp.com",
		media: "https://media.discordapp.net",
		invite: "https://discord.gg",
		template: "https://discord.new",
		gift: "https://discord.gift",
		scheduledEvent: "https://discord.com/events"
	};
	Object.freeze(exports.RouteBases);
	exports.OAuth2Routes = {
		authorizationURL: `${exports.RouteBases.api}${exports.Routes.oauth2Authorization()}`,
		tokenURL: `${exports.RouteBases.api}${exports.Routes.oauth2TokenExchange()}`,
		/**
		* @see {@link https://tools.ietf.org/html/rfc7009}
		*/
		tokenRevocationURL: `${exports.RouteBases.api}${exports.Routes.oauth2TokenRevocation()}`
	};
	Object.freeze(exports.OAuth2Routes);
}));
//#endregion
//#region node_modules/discord-api-types/rpc/common.js
var require_common = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.RPCCloseEventCodes = exports.RPCErrorCodes = exports.RelationshipType = exports.VoiceConnectionStates = exports.RPCVoiceShortcutKeyComboKeyType = exports.RPCVoiceSettingsModeType = exports.RPCDeviceType = void 0;
	var RPCDeviceType;
	(function(RPCDeviceType) {
		RPCDeviceType["AudioInput"] = "audioinput";
		RPCDeviceType["AudioOutput"] = "audiooutput";
		RPCDeviceType["VideoInput"] = "videoinput";
	})(RPCDeviceType || (exports.RPCDeviceType = RPCDeviceType = {}));
	var RPCVoiceSettingsModeType;
	(function(RPCVoiceSettingsModeType) {
		RPCVoiceSettingsModeType["PushToTalk"] = "PUSH_TO_TALK";
		RPCVoiceSettingsModeType["VoiceActivity"] = "VOICE_ACTIVITY";
	})(RPCVoiceSettingsModeType || (exports.RPCVoiceSettingsModeType = RPCVoiceSettingsModeType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/topics/rpc#getvoicesettings-key-types}
	*/
	var RPCVoiceShortcutKeyComboKeyType;
	(function(RPCVoiceShortcutKeyComboKeyType) {
		RPCVoiceShortcutKeyComboKeyType[RPCVoiceShortcutKeyComboKeyType["KeyboardKey"] = 0] = "KeyboardKey";
		RPCVoiceShortcutKeyComboKeyType[RPCVoiceShortcutKeyComboKeyType["MouseButton"] = 1] = "MouseButton";
		RPCVoiceShortcutKeyComboKeyType[RPCVoiceShortcutKeyComboKeyType["KeyboardModifierKey"] = 2] = "KeyboardModifierKey";
		RPCVoiceShortcutKeyComboKeyType[RPCVoiceShortcutKeyComboKeyType["GamepadButton"] = 3] = "GamepadButton";
	})(RPCVoiceShortcutKeyComboKeyType || (exports.RPCVoiceShortcutKeyComboKeyType = RPCVoiceShortcutKeyComboKeyType = {}));
	var VoiceConnectionStates;
	(function(VoiceConnectionStates) {
		/**
		* TCP disconnected
		*/
		VoiceConnectionStates["Disconnected"] = "DISCONNECTED";
		/**
		* Waiting for voice endpoint
		*/
		VoiceConnectionStates["AwaitingEndpoint"] = "AWAITING_ENDPOINT";
		/**
		* TCP authenticating
		*/
		VoiceConnectionStates["Authenticating"] = "AUTHENTICATING";
		/**
		* TCP connecting
		*/
		VoiceConnectionStates["Connecting"] = "CONNECTING";
		/**
		* TCP connected
		*/
		VoiceConnectionStates["Connected"] = "CONNECTED";
		/**
		* TCP connected, Voice disconnected
		*/
		VoiceConnectionStates["VoiceDisconnected"] = "VOICE_DISCONNECTED";
		/**
		* TCP connected, Voice connecting
		*/
		VoiceConnectionStates["VoiceConnecting"] = "VOICE_CONNECTING";
		/**
		* TCP connected, Voice connected
		*/
		VoiceConnectionStates["VoiceConnected"] = "VOICE_CONNECTED";
		/**
		* No route to host
		*/
		VoiceConnectionStates["NoRoute"] = "NO_ROUTE";
		/**
		* WebRTC ice checking
		*/
		VoiceConnectionStates["IceChecking"] = "ICE_CHECKING";
	})(VoiceConnectionStates || (exports.VoiceConnectionStates = VoiceConnectionStates = {}));
	/**
	* @unstable
	*/
	var RelationshipType;
	(function(RelationshipType) {
		RelationshipType[RelationshipType["None"] = 0] = "None";
		RelationshipType[RelationshipType["Friend"] = 1] = "Friend";
		RelationshipType[RelationshipType["Blocked"] = 2] = "Blocked";
		RelationshipType[RelationshipType["PendingIncoming"] = 3] = "PendingIncoming";
		RelationshipType[RelationshipType["PendingOutgoing"] = 4] = "PendingOutgoing";
		RelationshipType[RelationshipType["Implicit"] = 5] = "Implicit";
	})(RelationshipType || (exports.RelationshipType = RelationshipType = {}));
	/**
	* @see {@link https://discord.com/developers/docs/topics/opcodes-and-status-codes#rpc-rpc-error-codes}
	*/
	var RPCErrorCodes;
	(function(RPCErrorCodes) {
		/**
		* An unknown error occurred.
		*/
		RPCErrorCodes[RPCErrorCodes["UnknownError"] = 1e3] = "UnknownError";
		/**
		* @unstable
		*/
		RPCErrorCodes[RPCErrorCodes["ServiceUnavailable"] = 1001] = "ServiceUnavailable";
		/**
		* @unstable
		*/
		RPCErrorCodes[RPCErrorCodes["TransactionAborted"] = 1002] = "TransactionAborted";
		/**
		* You sent an invalid payload.
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidPayload"] = 4e3] = "InvalidPayload";
		/**
		* Invalid command name specified.
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidCommand"] = 4002] = "InvalidCommand";
		/**
		* Invalid guild ID specified.
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidGuild"] = 4003] = "InvalidGuild";
		/**
		* Invalid event name specified.
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidEvent"] = 4004] = "InvalidEvent";
		/**
		* Invalid channel ID specified.
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidChannel"] = 4005] = "InvalidChannel";
		/**
		* You lack permissions to access the given resource.
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidPermissions"] = 4006] = "InvalidPermissions";
		/**
		* An invalid OAuth2 application ID was used to authorize or authenticate with.
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidClientId"] = 4007] = "InvalidClientId";
		/**
		* An invalid OAuth2 application origin was used to authorize or authenticate with.
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidOrigin"] = 4008] = "InvalidOrigin";
		/**
		* An invalid OAuth2 token was used to authorize or authenticate with.
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidToken"] = 4009] = "InvalidToken";
		/**
		* The specified user ID was invalid.
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidUser"] = 4010] = "InvalidUser";
		/**
		* @unstable
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidInvite"] = 4011] = "InvalidInvite";
		/**
		* @unstable
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidActivityJoinRequest"] = 4012] = "InvalidActivityJoinRequest";
		/**
		* @unstable
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidEntitlement"] = 4013] = "InvalidEntitlement";
		/**
		* @unstable
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidGiftCode"] = 4014] = "InvalidGiftCode";
		/**
		* A standard OAuth2 error occurred; check the data object for the OAuth2 error details.
		*/
		RPCErrorCodes[RPCErrorCodes["OAuth2Error"] = 5e3] = "OAuth2Error";
		/**
		* An asynchronous `SELECT_TEXT_CHANNEL`/`SELECT_VOICE_CHANNEL` command timed out.
		*/
		RPCErrorCodes[RPCErrorCodes["SelectChannelTimedOut"] = 5001] = "SelectChannelTimedOut";
		/**
		* An asynchronous `GET_GUILD` command timed out.
		*/
		RPCErrorCodes[RPCErrorCodes["GetGuildTimedOut"] = 5002] = "GetGuildTimedOut";
		/**
		* You tried to join a user to a voice channel but the user was already in one.
		*/
		RPCErrorCodes[RPCErrorCodes["SelectVoiceForceRequired"] = 5003] = "SelectVoiceForceRequired";
		/**
		* You tried to capture more than one shortcut key at once.
		*/
		RPCErrorCodes[RPCErrorCodes["CaptureShortcutAlreadyListening"] = 5004] = "CaptureShortcutAlreadyListening";
		/**
		* @unstable
		*/
		RPCErrorCodes[RPCErrorCodes["InvalidActivitySecret"] = 5005] = "InvalidActivitySecret";
		/**
		* @unstable
		*/
		RPCErrorCodes[RPCErrorCodes["NoEligibleActivity"] = 5006] = "NoEligibleActivity";
		/**
		* @unstable
		*/
		RPCErrorCodes[RPCErrorCodes["PurchaseCanceled"] = 5007] = "PurchaseCanceled";
		/**
		* @unstable
		*/
		RPCErrorCodes[RPCErrorCodes["PurchaseError"] = 5008] = "PurchaseError";
		/**
		* @unstable
		*/
		RPCErrorCodes[RPCErrorCodes["UnauthorizedForAchievement"] = 5009] = "UnauthorizedForAchievement";
		/**
		* @unstable
		*/
		RPCErrorCodes[RPCErrorCodes["RateLimited"] = 5010] = "RateLimited";
	})(RPCErrorCodes || (exports.RPCErrorCodes = RPCErrorCodes = {}));
	/**
	* @see {@link https://discord.com/developers/docs/topics/opcodes-and-status-codes#rpc-rpc-close-event-codes}
	*/
	var RPCCloseEventCodes;
	(function(RPCCloseEventCodes) {
		/**
		* @unstable
		*/
		RPCCloseEventCodes[RPCCloseEventCodes["CloseNormal"] = 1e3] = "CloseNormal";
		/**
		* @unstable
		*/
		RPCCloseEventCodes[RPCCloseEventCodes["CloseUnsupported"] = 1003] = "CloseUnsupported";
		/**
		* @unstable
		*/
		RPCCloseEventCodes[RPCCloseEventCodes["CloseAbnormal"] = 1006] = "CloseAbnormal";
		/**
		* You connected to the RPC server with an invalid client ID.
		*/
		RPCCloseEventCodes[RPCCloseEventCodes["InvalidClientId"] = 4e3] = "InvalidClientId";
		/**
		* You connected to the RPC server with an invalid origin.
		*/
		RPCCloseEventCodes[RPCCloseEventCodes["InvalidOrigin"] = 4001] = "InvalidOrigin";
		/**
		* You are being rate limited.
		*/
		RPCCloseEventCodes[RPCCloseEventCodes["RateLimited"] = 4002] = "RateLimited";
		/**
		* The OAuth2 token associated with a connection was revoked, get a new one!
		*/
		RPCCloseEventCodes[RPCCloseEventCodes["TokenRevoked"] = 4003] = "TokenRevoked";
		/**
		* The RPC Server version specified in the connection string was not valid.
		*/
		RPCCloseEventCodes[RPCCloseEventCodes["InvalidVersion"] = 4004] = "InvalidVersion";
		/**
		* The encoding specified in the connection string was not valid.
		*/
		RPCCloseEventCodes[RPCCloseEventCodes["InvalidEncoding"] = 4005] = "InvalidEncoding";
	})(RPCCloseEventCodes || (exports.RPCCloseEventCodes = RPCCloseEventCodes = {}));
}));
//#endregion
//#region node_modules/discord-api-types/rpc/v10.js
var require_v10$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$2) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$2, p)) __createBinding(exports$2, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.RPCEvents = exports.RPCCommands = exports.RPCVersion = void 0;
	__exportStar(require_common(), exports);
	exports.RPCVersion = "1";
	/**
	* @see {@link https://discord.com/developers/docs/topics/rpc#commands-and-events-rpc-commands}
	*/
	var RPCCommands;
	(function(RPCCommands) {
		/**
		* @unstable
		*/
		RPCCommands["AcceptActivityInvite"] = "ACCEPT_ACTIVITY_INVITE";
		/**
		* @unstable
		*/
		RPCCommands["ActivityInviteUser"] = "ACTIVITY_INVITE_USER";
		/**
		* Used to authenticate an existing client with your app
		*/
		RPCCommands["Authenticate"] = "AUTHENTICATE";
		/**
		* Used to authorize a new client with your app
		*/
		RPCCommands["Authorize"] = "AUTHORIZE";
		/**
		* @unstable
		*/
		RPCCommands["BraintreePopupBridgeCallback"] = "BRAINTREE_POPUP_BRIDGE_CALLBACK";
		/**
		* @unstable
		*/
		RPCCommands["BrowserHandoff"] = "BROWSER_HANDOFF";
		/**
		* 	used to reject a Rich Presence Ask to Join request
		*
		* @unstable the documented similarly named command `CLOSE_ACTIVITY_REQUEST` does not exist, but `CLOSE_ACTIVITY_JOIN_REQUEST` does
		*/
		RPCCommands["CloseActivityJoinRequest"] = "CLOSE_ACTIVITY_JOIN_REQUEST";
		/**
		* @unstable
		*/
		RPCCommands["ConnectionsCallback"] = "CONNECTIONS_CALLBACK";
		RPCCommands["CreateChannelInvite"] = "CREATE_CHANNEL_INVITE";
		/**
		* @unstable
		*/
		RPCCommands["DeepLink"] = "DEEP_LINK";
		/**
		* Event dispatch
		*/
		RPCCommands["Dispatch"] = "DISPATCH";
		/**
		* @unstable
		*/
		RPCCommands["GetApplicationTicket"] = "GET_APPLICATION_TICKET";
		/**
		* Used to retrieve channel information from the client
		*/
		RPCCommands["GetChannel"] = "GET_CHANNEL";
		/**
		* Used to retrieve a list of channels for a guild from the client
		*/
		RPCCommands["GetChannels"] = "GET_CHANNELS";
		/**
		* @unstable
		*/
		RPCCommands["GetEntitlementTicket"] = "GET_ENTITLEMENT_TICKET";
		/**
		* @unstable
		*/
		RPCCommands["GetEntitlements"] = "GET_ENTITLEMENTS";
		/**
		* Used to retrieve guild information from the client
		*/
		RPCCommands["GetGuild"] = "GET_GUILD";
		/**
		* Used to retrieve a list of guilds from the client
		*/
		RPCCommands["GetGuilds"] = "GET_GUILDS";
		/**
		* @unstable
		*/
		RPCCommands["GetImage"] = "GET_IMAGE";
		/**
		* @unstable
		*/
		RPCCommands["GetNetworkingConfig"] = "GET_NETWORKING_CONFIG";
		/**
		* @unstable
		*/
		RPCCommands["GetRelationships"] = "GET_RELATIONSHIPS";
		/**
		* Used to get the current voice channel the client is in
		*/
		RPCCommands["GetSelectedVoiceChannel"] = "GET_SELECTED_VOICE_CHANNEL";
		/**
		* @unstable
		*/
		RPCCommands["GetSkus"] = "GET_SKUS";
		/**
		* @unstable
		*/
		RPCCommands["GetUser"] = "GET_USER";
		/**
		* Used to retrieve the client's voice settings
		*/
		RPCCommands["GetVoiceSettings"] = "GET_VOICE_SETTINGS";
		/**
		* @unstable
		*/
		RPCCommands["GiftCodeBrowser"] = "GIFT_CODE_BROWSER";
		/**
		* @unstable
		*/
		RPCCommands["GuildTemplateBrowser"] = "GUILD_TEMPLATE_BROWSER";
		/**
		* @unstable
		*/
		RPCCommands["InviteBrowser"] = "INVITE_BROWSER";
		/**
		* @unstable
		*/
		RPCCommands["NetworkingCreateToken"] = "NETWORKING_CREATE_TOKEN";
		/**
		* @unstable
		*/
		RPCCommands["NetworkingPeerMetrics"] = "NETWORKING_PEER_METRICS";
		/**
		* @unstable
		*/
		RPCCommands["NetworkingSystemMetrics"] = "NETWORKING_SYSTEM_METRICS";
		/**
		* @unstable
		*/
		RPCCommands["OpenOverlayActivityInvite"] = "OPEN_OVERLAY_ACTIVITY_INVITE";
		/**
		* @unstable
		*/
		RPCCommands["OpenOverlayGuildInvite"] = "OPEN_OVERLAY_GUILD_INVITE";
		/**
		* @unstable
		*/
		RPCCommands["OpenOverlayVoiceSettings"] = "OPEN_OVERLAY_VOICE_SETTINGS";
		/**
		* @unstable
		*/
		RPCCommands["Overlay"] = "OVERLAY";
		/**
		* Used to join or leave a text channel, group dm, or dm
		*/
		RPCCommands["SelectTextChannel"] = "SELECT_TEXT_CHANNEL";
		/**
		* Used to join or leave a voice channel, group dm, or dm
		*/
		RPCCommands["SelectVoiceChannel"] = "SELECT_VOICE_CHANNEL";
		/**
		* Used to consent to a Rich Presence Ask to Join request
		*/
		RPCCommands["SendActivityJoinInvite"] = "SEND_ACTIVITY_JOIN_INVITE";
		/**
		* Used to update a user's Rich Presence
		*/
		RPCCommands["SetActivity"] = "SET_ACTIVITY";
		/**
		* Used to send info about certified hardware devices
		*/
		RPCCommands["SetCertifiedDevices"] = "SET_CERTIFIED_DEVICES";
		/**
		* @unstable
		*/
		RPCCommands["SetOverlayLocked"] = "SET_OVERLAY_LOCKED";
		/**
		* Used to change voice settings of users in voice channels
		*/
		RPCCommands["SetUserVoiceSettings"] = "SET_USER_VOICE_SETTINGS";
		RPCCommands["SetUserVoiceSettings2"] = "SET_USER_VOICE_SETTINGS_2";
		/**
		* Used to set the client's voice settings
		*/
		RPCCommands["SetVoiceSettings"] = "SET_VOICE_SETTINGS";
		RPCCommands["SetVoiceSettings2"] = "SET_VOICE_SETTINGS_2";
		/**
		* @unstable
		*/
		RPCCommands["StartPurchase"] = "START_PURCHASE";
		/**
		* Used to subscribe to an RPC event
		*/
		RPCCommands["Subscribe"] = "SUBSCRIBE";
		/**
		* Used to unsubscribe from an RPC event
		*/
		RPCCommands["Unsubscribe"] = "UNSUBSCRIBE";
		/**
		* @unstable
		*/
		RPCCommands["ValidateApplication"] = "VALIDATE_APPLICATION";
	})(RPCCommands || (exports.RPCCommands = RPCCommands = {}));
	/**
	* @see {@link https://discord.com/developers/docs/topics/rpc#commands-and-events-rpc-events}
	*/
	var RPCEvents;
	(function(RPCEvents) {
		/**
		* @unstable
		*/
		RPCEvents["ActivityInvite"] = "ACTIVITY_INVITE";
		RPCEvents["ActivityJoin"] = "ACTIVITY_JOIN";
		RPCEvents["ActivityJoinRequest"] = "ACTIVITY_JOIN_REQUEST";
		RPCEvents["ActivitySpectate"] = "ACTIVITY_SPECTATE";
		RPCEvents["ChannelCreate"] = "CHANNEL_CREATE";
		RPCEvents["CurrentUserUpdate"] = "CURRENT_USER_UPDATE";
		/**
		* @unstable
		*/
		RPCEvents["EntitlementCreate"] = "ENTITLEMENT_CREATE";
		/**
		* @unstable
		*/
		RPCEvents["EntitlementDelete"] = "ENTITLEMENT_DELETE";
		RPCEvents["Error"] = "ERROR";
		/**
		* @unstable
		*/
		RPCEvents["GameJoin"] = "GAME_JOIN";
		/**
		* @unstable
		*/
		RPCEvents["GameSpectate"] = "GAME_SPECTATE";
		RPCEvents["GuildCreate"] = "GUILD_CREATE";
		RPCEvents["GuildStatus"] = "GUILD_STATUS";
		/**
		* Dispatches message objects, with the exception of deletions, which only contains the id in the message object.
		*/
		RPCEvents["MessageCreate"] = "MESSAGE_CREATE";
		/**
		* Dispatches message objects, with the exception of deletions, which only contains the id in the message object.
		*/
		RPCEvents["MessageDelete"] = "MESSAGE_DELETE";
		/**
		* Dispatches message objects, with the exception of deletions, which only contains the id in the message object.
		*/
		RPCEvents["MessageUpdate"] = "MESSAGE_UPDATE";
		/**
		* This event requires the `rpc.notifications.read` {@link https://discord.com/developers/docs/topics/oauth2#shared-resources-oauth2-scopes | OAuth2 scope}.
		*/
		RPCEvents["NotificationCreate"] = "NOTIFICATION_CREATE";
		/**
		* @unstable
		*/
		RPCEvents["Overlay"] = "OVERLAY";
		/**
		* @unstable
		*/
		RPCEvents["OverlayUpdate"] = "OVERLAY_UPDATE";
		RPCEvents["Ready"] = "READY";
		/**
		* @unstable
		*/
		RPCEvents["RelationshipUpdate"] = "RELATIONSHIP_UPDATE";
		RPCEvents["SpeakingStart"] = "SPEAKING_START";
		RPCEvents["SpeakingStop"] = "SPEAKING_STOP";
		RPCEvents["VoiceChannelSelect"] = "VOICE_CHANNEL_SELECT";
		RPCEvents["VoiceConnectionStatus"] = "VOICE_CONNECTION_STATUS";
		RPCEvents["VoiceSettingsUpdate"] = "VOICE_SETTINGS_UPDATE";
		/**
		* @unstable
		*/
		RPCEvents["VoiceSettingsUpdate2"] = "VOICE_SETTINGS_UPDATE_2";
		/**
		* Dispatches channel voice state objects
		*/
		RPCEvents["VoiceStateCreate"] = "VOICE_STATE_CREATE";
		/**
		* Dispatches channel voice state objects
		*/
		RPCEvents["VoiceStateDelete"] = "VOICE_STATE_DELETE";
		/**
		* Dispatches channel voice state objects
		*/
		RPCEvents["VoiceStateUpdate"] = "VOICE_STATE_UPDATE";
	})(RPCEvents || (exports.RPCEvents = RPCEvents = {}));
}));
//#endregion
//#region node_modules/discord-api-types/utils/v10.js
var require_v10$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.isDMInteraction = isDMInteraction;
	exports.isGuildInteraction = isGuildInteraction;
	exports.isApplicationCommandDMInteraction = isApplicationCommandDMInteraction;
	exports.isApplicationCommandGuildInteraction = isApplicationCommandGuildInteraction;
	exports.isMessageComponentDMInteraction = isMessageComponentDMInteraction;
	exports.isMessageComponentGuildInteraction = isMessageComponentGuildInteraction;
	exports.isLinkButton = isLinkButton;
	exports.isInteractionButton = isInteractionButton;
	exports.isModalSubmitInteraction = isModalSubmitInteraction;
	exports.isMessageComponentInteraction = isMessageComponentInteraction;
	exports.isMessageComponentButtonInteraction = isMessageComponentButtonInteraction;
	exports.isMessageComponentSelectMenuInteraction = isMessageComponentSelectMenuInteraction;
	exports.isChatInputApplicationCommandInteraction = isChatInputApplicationCommandInteraction;
	exports.isContextMenuApplicationCommandInteraction = isContextMenuApplicationCommandInteraction;
	const index_1 = require_v10$4();
	/**
	* A type guard check for DM interactions
	*
	* @param interaction - The interaction to check against
	* @returns A boolean that indicates if the interaction was received in a DM channel
	*/
	function isDMInteraction(interaction) {
		return Reflect.has(interaction, "user");
	}
	/**
	* A type guard check for guild interactions
	*
	* @param interaction - The interaction to check against
	* @returns A boolean that indicates if the interaction was received in a guild
	*/
	function isGuildInteraction(interaction) {
		return Reflect.has(interaction, "guild_id");
	}
	/**
	* A type guard check for DM application command interactions
	*
	* @param interaction - The application command interaction to check against
	* @returns A boolean that indicates if the application command interaction was received in a DM channel
	*/
	function isApplicationCommandDMInteraction(interaction) {
		return isDMInteraction(interaction);
	}
	/**
	* A type guard check for guild application command interactions
	*
	* @param interaction - The interaction to check against
	* @returns A boolean that indicates if the application command interaction was received in a guild
	*/
	function isApplicationCommandGuildInteraction(interaction) {
		return isGuildInteraction(interaction);
	}
	/**
	* A type guard check for DM message component interactions
	*
	* @param interaction - The message component interaction to check against
	* @returns A boolean that indicates if the message component interaction was received in a DM channel
	*/
	function isMessageComponentDMInteraction(interaction) {
		return isDMInteraction(interaction);
	}
	/**
	* A type guard check for guild message component interactions
	*
	* @param interaction - The interaction to check against
	* @returns A boolean that indicates if the message component interaction was received in a guild
	*/
	function isMessageComponentGuildInteraction(interaction) {
		return isGuildInteraction(interaction);
	}
	/**
	* A type guard check for buttons that have a `url` attached to them.
	*
	* @param component - The button to check against
	* @returns A boolean that indicates if the button has a `url` attached to it
	*/
	function isLinkButton(component) {
		return component.style === index_1.ButtonStyle.Link;
	}
	/**
	* A type guard check for buttons that have a `custom_id` attached to them.
	*
	* @param component - The button to check against
	* @returns A boolean that indicates if the button has a `custom_id` attached to it
	*/
	function isInteractionButton(component) {
		return ![index_1.ButtonStyle.Link, index_1.ButtonStyle.Premium].includes(component.style);
	}
	/**
	* A type guard check for modals submit interactions
	*
	* @param interaction - The interaction to check against
	* @returns A boolean that indicates if the interaction is a modal submission
	*/
	function isModalSubmitInteraction(interaction) {
		return interaction.type === index_1.InteractionType.ModalSubmit;
	}
	/**
	* A type guard check for message component interactions
	*
	* @param interaction - The interaction to check against
	* @returns A boolean that indicates if the interaction is a message component
	*/
	function isMessageComponentInteraction(interaction) {
		return interaction.type === index_1.InteractionType.MessageComponent;
	}
	/**
	* A type guard check for button message component interactions
	*
	* @param interaction - The message component interaction to check against
	* @returns A boolean that indicates if the message component is a button
	*/
	function isMessageComponentButtonInteraction(interaction) {
		return interaction.data.component_type === index_1.ComponentType.Button;
	}
	/**
	* A type guard check for select menu message component interactions
	*
	* @param interaction - The message component interaction to check against
	* @returns A boolean that indicates if the message component is a select menu
	*/
	function isMessageComponentSelectMenuInteraction(interaction) {
		return [
			index_1.ComponentType.StringSelect,
			index_1.ComponentType.UserSelect,
			index_1.ComponentType.RoleSelect,
			index_1.ComponentType.MentionableSelect,
			index_1.ComponentType.ChannelSelect
		].includes(interaction.data.component_type);
	}
	/**
	* A type guard check for chat input application commands.
	*
	* @param interaction - The interaction to check against
	* @returns A boolean that indicates if the interaction is a chat input application command
	*/
	function isChatInputApplicationCommandInteraction(interaction) {
		return interaction.data.type === index_1.ApplicationCommandType.ChatInput;
	}
	/**
	* A type guard check for context menu application commands.
	*
	* @param interaction - The interaction to check against
	* @returns A boolean that indicates if the interaction is a context menu application command
	*/
	function isContextMenuApplicationCommandInteraction(interaction) {
		return interaction.data.type === index_1.ApplicationCommandType.Message || interaction.data.type === index_1.ApplicationCommandType.User;
	}
}));
//#endregion
//#region node_modules/discord-api-types/v10.mjs
var import_v10 = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __exportStar = exports && exports.__exportStar || function(m, exports$1) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$1, p)) __createBinding(exports$1, m, p);
	};
	var __importStar = exports && exports.__importStar || (function() {
		var ownKeys = function(o) {
			ownKeys = Object.getOwnPropertyNames || function(o) {
				var ar = [];
				for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
				return ar;
			};
			return ownKeys(o);
		};
		return function(mod) {
			if (mod && mod.__esModule) return mod;
			var result = {};
			if (mod != null) {
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
			}
			__setModuleDefault(result, mod);
			return result;
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Utils = void 0;
	__exportStar(require_v10$5(), exports);
	__exportStar(require_globals(), exports);
	__exportStar(require_v10$4(), exports);
	__exportStar(require_v10$3(), exports);
	__exportStar(require_v10$2(), exports);
	__exportStar(require_internals(), exports);
	exports.Utils = __importStar(require_v10$1());
})))(), 1);
import_v10.default.APIApplicationCommandPermissionsConstant;
import_v10.default.APIVersion;
import_v10.default.ActivityFlags;
import_v10.default.ActivityLocationKind;
import_v10.default.ActivityPlatform;
import_v10.default.ActivityType;
import_v10.default.AllowedMentionsTypes;
const ApplicationCommandOptionType = import_v10.default.ApplicationCommandOptionType;
import_v10.default.ApplicationCommandPermissionType;
const ApplicationCommandType = import_v10.default.ApplicationCommandType;
import_v10.default.ApplicationFlags;
import_v10.default.ApplicationIntegrationType;
import_v10.default.ApplicationRoleConnectionMetadataType;
import_v10.default.ApplicationWebhookEventStatus;
import_v10.default.ApplicationWebhookEventType;
import_v10.default.ApplicationWebhookType;
import_v10.default.AttachmentFlags;
import_v10.default.AuditLogEvent;
import_v10.default.AuditLogOptionsType;
import_v10.default.AutoModerationActionType;
import_v10.default.AutoModerationRuleEventType;
import_v10.default.AutoModerationRuleKeywordPresetType;
import_v10.default.AutoModerationRuleTriggerType;
import_v10.default.BaseThemeType;
const ButtonStyle = import_v10.default.ButtonStyle;
import_v10.default.CDNRoutes;
import_v10.default.CannotSendMessagesToThisUserErrorCodes;
import_v10.default.ChannelFlags;
const ChannelType = import_v10.default.ChannelType;
const ComponentType = import_v10.default.ComponentType;
import_v10.default.ConnectionService;
import_v10.default.ConnectionVisibility;
import_v10.default.EmbedFlags;
import_v10.default.EmbedMediaFlags;
import_v10.default.EmbedType;
import_v10.default.EntitlementOwnerType;
import_v10.default.EntitlementType;
import_v10.default.EntryPointCommandHandlerType;
import_v10.default.FormattingPatterns;
import_v10.default.ForumLayoutType;
const GatewayCloseCodes = import_v10.default.GatewayCloseCodes;
const GatewayDispatchEvents = import_v10.default.GatewayDispatchEvents;
const GatewayIntentBits = import_v10.default.GatewayIntentBits;
const GatewayOpcodes = import_v10.default.GatewayOpcodes;
import_v10.default.GatewayVersion;
import_v10.default.GuildDefaultMessageNotifications;
import_v10.default.GuildExplicitContentFilter;
import_v10.default.GuildFeature;
import_v10.default.GuildHubType;
import_v10.default.GuildMFALevel;
import_v10.default.GuildMemberFlags;
import_v10.default.GuildNSFWLevel;
import_v10.default.GuildOnboardingMode;
import_v10.default.GuildOnboardingPromptType;
import_v10.default.GuildPremiumTier;
import_v10.default.GuildScheduledEventEntityType;
import_v10.default.GuildScheduledEventPrivacyLevel;
import_v10.default.GuildScheduledEventRecurrenceRuleFrequency;
import_v10.default.GuildScheduledEventRecurrenceRuleMonth;
import_v10.default.GuildScheduledEventRecurrenceRuleWeekday;
import_v10.default.GuildScheduledEventStatus;
import_v10.default.GuildSystemChannelFlags;
import_v10.default.GuildVerificationLevel;
import_v10.default.GuildWidgetStyle;
import_v10.default.ImageFormat;
import_v10.default.IntegrationExpireBehavior;
const InteractionContextType = import_v10.default.InteractionContextType;
const InteractionResponseType = import_v10.default.InteractionResponseType;
const InteractionType = import_v10.default.InteractionType;
import_v10.default.InviteFlags;
import_v10.default.InviteTargetType;
import_v10.default.InviteType;
import_v10.default.Locale;
import_v10.default.MembershipScreeningFieldType;
import_v10.default.MessageActivityType;
const MessageFlags = import_v10.default.MessageFlags;
import_v10.default.MessageReferenceType;
import_v10.default.MessageSearchAuthorType;
import_v10.default.MessageSearchEmbedType;
import_v10.default.MessageSearchHasType;
import_v10.default.MessageSearchSortMode;
const MessageType = import_v10.default.MessageType;
import_v10.default.NameplatePalette;
import_v10.default.OAuth2Routes;
import_v10.default.OAuth2Scopes;
import_v10.default.OverwriteType;
const PermissionFlagsBits = import_v10.default.PermissionFlagsBits;
import_v10.default.PollLayoutType;
import_v10.default.PresenceUpdateStatus;
import_v10.default.RESTJSONErrorCodes;
import_v10.default.RPCCloseEventCodes;
import_v10.default.RPCCommands;
import_v10.default.RPCDeviceType;
import_v10.default.RPCErrorCodes;
import_v10.default.RPCEvents;
import_v10.default.RPCVersion;
import_v10.default.RPCVoiceSettingsModeType;
import_v10.default.RPCVoiceShortcutKeyComboKeyType;
import_v10.default.ReactionType;
import_v10.default.RelationshipType;
import_v10.default.RoleFlags;
import_v10.default.RouteBases;
const Routes = import_v10.default.Routes;
import_v10.default.SKUFlags;
import_v10.default.SKUType;
import_v10.default.SelectMenuDefaultValueType;
import_v10.default.SeparatorSpacingSize;
import_v10.default.SortOrderType;
import_v10.default.StageInstancePrivacyLevel;
import_v10.default.StatusDisplayType;
const StickerFormatType = import_v10.default.StickerFormatType;
import_v10.default.StickerPackApplicationId;
import_v10.default.StickerType;
import_v10.default.SubscriptionStatus;
import_v10.default.TeamMemberMembershipState;
import_v10.default.TeamMemberRole;
const TextInputStyle = import_v10.default.TextInputStyle;
import_v10.default.ThreadAutoArchiveDuration;
import_v10.default.ThreadMemberFlags;
import_v10.default.UnfurledMediaItemFlags;
import_v10.default.UnfurledMediaItemLoadingState;
import_v10.default.UserFlags;
import_v10.default.UserPremiumType;
import_v10.default.Utils;
import_v10.default.VideoQualityMode;
import_v10.default.VoiceChannelEffectSendAnimationType;
import_v10.default.VoiceConnectionStates;
import_v10.default.WebhookType;
import_v10.default.urlSafeCharacters;
//#endregion
//#region extensions/discord/src/internal/api.commands.ts
async function listApplicationCommands(rest, clientId) {
	return await rest.get(Routes.applicationCommands(clientId));
}
async function createApplicationCommand(rest, clientId, body) {
	return await rest.post(Routes.applicationCommands(clientId), { body });
}
async function editApplicationCommand(rest, clientId, commandId, body) {
	return await rest.patch(Routes.applicationCommand(clientId, commandId), { body });
}
async function deleteApplicationCommand(rest, clientId, commandId) {
	await rest.delete(Routes.applicationCommand(clientId, commandId));
}
async function overwriteApplicationCommands(rest, clientId, body) {
	await rest.put(Routes.applicationCommands(clientId), { body });
}
async function overwriteGuildApplicationCommands(rest, clientId, guildId, body) {
	await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
}
//#endregion
//#region extensions/discord/src/internal/api.guild.ts
async function getGuild(rest, guildId) {
	return await rest.get(Routes.guild(guildId));
}
async function createGuildChannel(rest, guildId, data) {
	return await rest.post(Routes.guildChannels(guildId), data);
}
async function moveGuildChannels(rest, guildId, data) {
	await rest.patch(Routes.guildChannels(guildId), data);
}
async function getGuildMember(rest, guildId, userId) {
	return await rest.get(Routes.guildMember(guildId, userId));
}
async function listGuildRoles(rest, guildId) {
	return await rest.get(Routes.guildRoles(guildId));
}
async function listGuildChannels(rest, guildId) {
	return await rest.get(Routes.guildChannels(guildId));
}
async function putChannelPermission(rest, channelId, targetId, data) {
	await rest.put(Routes.channelPermission(channelId, targetId), data);
}
async function deleteChannelPermission(rest, channelId, targetId) {
	await rest.delete(Routes.channelPermission(channelId, targetId));
}
async function listGuildActiveThreads(rest, guildId) {
	return await rest.get(Routes.guildActiveThreads(guildId));
}
async function getGuildVoiceState(rest, guildId, userId) {
	return await rest.get(Routes.guildVoiceState(guildId, userId));
}
async function listGuildScheduledEvents(rest, guildId) {
	return await rest.get(Routes.guildScheduledEvents(guildId));
}
async function createGuildScheduledEvent(rest, guildId, body) {
	return await rest.post(Routes.guildScheduledEvents(guildId), { body });
}
async function timeoutGuildMember(rest, guildId, userId, data) {
	return await rest.patch(Routes.guildMember(guildId, userId), data);
}
async function addGuildMemberRole(rest, guildId, userId, roleId) {
	await rest.put(Routes.guildMemberRole(guildId, userId, roleId));
}
async function removeGuildMemberRole(rest, guildId, userId, roleId) {
	await rest.delete(Routes.guildMemberRole(guildId, userId, roleId));
}
async function removeGuildMember(rest, guildId, userId, data) {
	await rest.delete(Routes.guildMember(guildId, userId), data);
}
async function createGuildBan(rest, guildId, userId, data) {
	await rest.put(Routes.guildBan(guildId, userId), data);
}
async function listGuildEmojis(rest, guildId) {
	return await rest.get(Routes.guildEmojis(guildId));
}
async function createGuildEmoji(rest, guildId, data) {
	return await rest.post(Routes.guildEmojis(guildId), data);
}
async function createGuildSticker(rest, guildId, data) {
	return await rest.post(Routes.guildStickers(guildId), data);
}
//#endregion
//#region extensions/discord/src/internal/api.interactions.ts
async function createInteractionCallback(rest, interactionId, token, body) {
	return await rest.post(Routes.interactionCallback(interactionId, token), { body });
}
async function editWebhookMessage(rest, applicationId, token, messageId, data, query) {
	return query ? await rest.patch(Routes.webhookMessage(applicationId, token, messageId), data, query) : await rest.patch(Routes.webhookMessage(applicationId, token, messageId), data);
}
async function deleteWebhookMessage(rest, applicationId, token, messageId) {
	return await rest.delete(Routes.webhookMessage(applicationId, token, messageId));
}
async function getWebhookMessage(rest, applicationId, token, messageId) {
	return await rest.get(Routes.webhookMessage(applicationId, token, messageId));
}
async function createWebhookMessage(rest, applicationId, token, data, query) {
	return await rest.post(Routes.webhook(applicationId, token), data, query);
}
//#endregion
//#region extensions/discord/src/internal/api.messages.ts
async function getChannel(rest, channelId) {
	return await rest.get(Routes.channel(channelId));
}
async function editChannel(rest, channelId, data) {
	return await rest.patch(Routes.channel(channelId), data);
}
async function deleteChannel(rest, channelId) {
	await rest.delete(Routes.channel(channelId));
}
async function listChannelMessages(rest, channelId, query) {
	return await rest.get(Routes.channelMessages(channelId), query);
}
async function getChannelMessage(rest, channelId, messageId) {
	return await rest.get(Routes.channelMessage(channelId, messageId));
}
async function createChannelMessage(rest, channelId, data) {
	return await rest.post(Routes.channelMessages(channelId), data);
}
async function editChannelMessage(rest, channelId, messageId, data) {
	return await rest.patch(Routes.channelMessage(channelId, messageId), data);
}
async function deleteChannelMessage(rest, channelId, messageId) {
	await rest.delete(Routes.channelMessage(channelId, messageId));
}
async function pinChannelMessage(rest, channelId, messageId) {
	await rest.put(Routes.channelPin(channelId, messageId));
}
async function unpinChannelMessage(rest, channelId, messageId) {
	await rest.delete(Routes.channelPin(channelId, messageId));
}
async function listChannelPins(rest, channelId) {
	return await rest.get(Routes.channelPins(channelId));
}
async function sendChannelTyping(rest, channelId) {
	await rest.post(Routes.channelTyping(channelId));
}
async function createThread(rest, channelId, data, messageId) {
	const route = messageId ? Routes.threads(channelId, messageId) : Routes.threads(channelId);
	return await rest.post(route, data);
}
async function listChannelArchivedThreads(rest, channelId, query) {
	return await rest.get(Routes.channelThreads(channelId, "public"), query);
}
async function searchGuildMessages(rest, guildId, params) {
	return await rest.get(`/guilds/${guildId}/messages/search?${params.toString()}`);
}
//#endregion
//#region extensions/discord/src/internal/api.reactions.ts
async function createOwnMessageReaction(rest, channelId, messageId, encodedEmoji) {
	await rest.put(Routes.channelMessageOwnReaction(channelId, messageId, encodedEmoji));
}
async function deleteOwnMessageReaction(rest, channelId, messageId, encodedEmoji) {
	await rest.delete(Routes.channelMessageOwnReaction(channelId, messageId, encodedEmoji));
}
async function listMessageReactionUsers(rest, channelId, messageId, encodedEmoji, query) {
	return await rest.get(Routes.channelMessageReaction(channelId, messageId, encodedEmoji), query);
}
//#endregion
//#region extensions/discord/src/internal/api.users.ts
async function getCurrentUser(rest) {
	return await rest.get(Routes.user("@me"));
}
async function getUser(rest, userId) {
	return await rest.get(Routes.user(userId));
}
async function createUserDmChannel(rest, recipientId) {
	return await rest.post(Routes.userChannels(), { body: { recipient_id: recipientId } });
}
//#endregion
//#region extensions/discord/src/internal/api.webhooks.ts
async function createChannelWebhook(rest, channelId, data) {
	return await rest.post(Routes.channelWebhooks(channelId), data);
}
//#endregion
//#region extensions/discord/src/internal/command-deploy.ts
var DiscordCommandDeployer = class {
	constructor(params) {
		this.params = params;
		this.hashes = /* @__PURE__ */ new Map();
		this.hashesLoaded = false;
	}
	async getCommands() {
		return await listApplicationCommands(this.rest, this.params.clientId);
	}
	async deploy(options = {}) {
		const commands = this.params.commands.filter((command) => command.name !== "*");
		const serializedGlobal = commands.filter((command) => !command.guildIds).map((command) => command.serialize());
		for (const [guildId, entries] of groupGuildCommands(commands)) await this.putCommandSetIfChanged(`guild:${guildId}`, entries, async () => {
			await overwriteGuildApplicationCommands(this.rest, this.params.clientId, guildId, entries);
		}, options);
		if (this.params.devGuilds?.length) {
			for (const guildId of this.params.devGuilds) {
				const entries = commands.map((command) => command.serialize());
				await this.putCommandSetIfChanged(`dev-guild:${guildId}`, entries, async () => {
					await overwriteGuildApplicationCommands(this.rest, this.params.clientId, guildId, entries);
				}, options);
			}
			return {
				mode: options.mode ?? "reconcile",
				usedDevGuilds: true
			};
		}
		if (options.mode !== "overwrite") {
			await this.putCommandSetIfChanged("global:reconcile", serializedGlobal, async () => {
				await this.reconcileGlobalCommands(serializedGlobal);
			}, options);
			return {
				mode: "reconcile",
				usedDevGuilds: false
			};
		}
		await this.putCommandSetIfChanged("global:overwrite", serializedGlobal, async () => {
			await overwriteApplicationCommands(this.rest, this.params.clientId, serializedGlobal);
		}, options);
		return {
			mode: "overwrite",
			usedDevGuilds: false
		};
	}
	async reconcileGlobalCommands(desired) {
		const existing = await this.getCommands();
		const existingByKey = new Map(existing.map((command) => [stableCommandKey(command), command]));
		const desiredKeys = /* @__PURE__ */ new Set();
		for (const command of desired) {
			const key = stableCommandKey(command);
			desiredKeys.add(key);
			const current = existingByKey.get(key);
			if (!current) {
				await createApplicationCommand(this.rest, this.params.clientId, command);
				continue;
			}
			if (!commandsEqual(current, command)) await editApplicationCommand(this.rest, this.params.clientId, current.id, command);
		}
		for (const command of existing) if (!desiredKeys.has(stableCommandKey(command))) await deleteApplicationCommand(this.rest, this.params.clientId, command.id);
	}
	async putCommandSetIfChanged(key, commands, deploy, options) {
		const hash = stableCommandSetHash(commands);
		await this.loadPersistedHashes();
		if (!options.force && this.hashes.get(key) === hash) return;
		await deploy();
		this.hashes.set(key, hash);
		await this.persistHashes();
	}
	async loadPersistedHashes() {
		if (this.hashesLoaded) return;
		this.hashesLoaded = true;
		const storePath = this.params.hashStorePath;
		if (!storePath) return;
		try {
			const parsed = await privateFileStore(path.dirname(storePath)).readJsonIfExists(path.basename(storePath));
			if (!parsed?.hashes || typeof parsed.hashes !== "object") return;
			for (const [key, value] of Object.entries(parsed.hashes)) if (typeof value === "string" && key.trim() && value.trim()) this.hashes.set(key, value);
		} catch {}
	}
	async persistHashes() {
		const storePath = this.params.hashStorePath;
		if (!storePath) return;
		try {
			await privateFileStore(path.dirname(storePath)).writeJson(path.basename(storePath), {
				version: 1,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
				hashes: Object.fromEntries([...this.hashes.entries()].toSorted(([left], [right]) => left.localeCompare(right)))
			}, { trailingNewline: true });
		} catch {}
	}
	get rest() {
		return this.params.rest();
	}
};
function groupGuildCommands(commands) {
	const guildCommands = /* @__PURE__ */ new Map();
	for (const command of commands.filter((entry) => entry.guildIds)) for (const guildId of command.guildIds ?? []) {
		const entries = guildCommands.get(guildId) ?? [];
		entries.push(command.serialize());
		guildCommands.set(guildId, entries);
	}
	return guildCommands;
}
function stableCommandKey(command) {
	return `${command.type ?? ApplicationCommandType.ChatInput}:${command.name}`;
}
function comparableCommand(value) {
	if (!value || typeof value !== "object") return value;
	const omit = new Set([
		"application_id",
		"description_localized",
		"dm_permission",
		"guild_id",
		"id",
		"name_localized",
		"nsfw",
		"version",
		"default_permission"
	]);
	return stableComparableObject(Object.fromEntries(Object.entries(value).filter(([key, entry]) => !omit.has(key) && entry !== void 0)));
}
const unorderedCommandArrayFields = new Set([
	"channel_types",
	"contexts",
	"integration_types"
]);
const optionComparisonOmittedFields = new Set([
	"contexts",
	"default_member_permissions",
	"description_localized",
	"integration_types",
	"name_localized"
]);
const nullableLocalizationFields = new Set(["description_localizations", "name_localizations"]);
function stableComparableObject(value, path = []) {
	if (Array.isArray(value)) {
		const normalized = value.map((entry) => stableComparableObject(entry, path));
		const key = path.at(-1);
		if (key && unorderedCommandArrayFields.has(key) && normalized.every((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")) return normalized.toSorted((left, right) => String(left).localeCompare(String(right)));
		return normalized;
	}
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).filter(([key, entry]) => {
		if (entry === void 0) return false;
		if (entry === null && nullableLocalizationFields.has(key)) return false;
		if (path.includes("options") && optionComparisonOmittedFields.has(key)) return false;
		if ((key === "required" || key === "autocomplete") && entry === false) return false;
		return true;
	}).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, shouldNormalizeDescriptionValue(path, key, entry) ? normalizeDescriptionForComparison(entry) : stableComparableObject(entry, [...path, key])]));
}
function shouldNormalizeDescriptionValue(path, key, entry) {
	return typeof entry === "string" && (key === "description" || path.at(-1) === "description_localizations");
}
/**
* Normalize a Discord command description for equality comparison.
*
* Discord's server-side storage performs two transformations that our local
* desired descriptors do not:
*
* 1. Consecutive whitespace (including `\n`) is collapsed to a single space.
* 2. Whitespace between two CJK (Chinese, Japanese, Korean) characters is
*    removed entirely. So a local description `"第一行。\n第二行。"` is stored
*    as `"第一行。第二行。"` on Discord and returned without the `\n`.
*
* Without this normalization every startup for any CJK-heavy deployment reads
* back Discord's collapsed form, computes a diff against the local `\n`-form,
* decides the command needs updating, and issues a `PATCH`. Under the global
* per-application rate limit this quickly produces 429 bursts and some
* commands silently fail to register (see the Discord deploy 429 reports).
*
* Applying the same transformation to both sides before comparison makes the
* equality check match Discord's storage semantics and prevents spurious
* reconcile writes on every startup.
*/
function normalizeDescriptionForComparison(description) {
	const collapsed = description.replace(/\s+/g, " ");
	const cjkBoundaryWhitespace = /([\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])\s+([\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])/g;
	return collapsed.replace(cjkBoundaryWhitespace, "$1$2").replace(cjkBoundaryWhitespace, "$1$2").trim();
}
function commandsEqual(a, b) {
	return JSON.stringify(comparableCommand(a)) === JSON.stringify(comparableCommand(b));
}
function stableCommandSetHash(commands) {
	const stable = commands.map((command) => stableComparableObject(command)).toSorted((a, b) => stableCommandKey(a).localeCompare(stableCommandKey(b)));
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
//#endregion
//#region extensions/discord/src/internal/components.base.ts
function parseCustomId(id) {
	const [rawKey, ...parts] = id.split(";");
	const [keyPart, firstValue] = rawKey.split("=");
	const key = keyPart.includes(":") ? keyPart.split(":")[0] : keyPart;
	const data = {};
	const entries = firstValue === void 0 ? parts : [rawKey.slice(key.length + 1), ...parts];
	for (const entry of entries) {
		const index = entry.indexOf("=");
		if (index < 0) continue;
		const name = entry.slice(0, index).replace(/^[^:]+:/, "");
		const raw = entry.slice(index + 1);
		data[name] = raw === "true" ? true : raw === "false" ? false : raw;
	}
	return {
		key,
		data
	};
}
function clean$3(value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0));
}
function colorToNumber(value) {
	if (typeof value === "number") return value;
	if (typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value)) return Number.parseInt(value.replace(/^#/, ""), 16);
}
var BaseComponent = class {
	constructor() {
		this.isV2 = false;
	}
};
var BaseMessageInteractiveComponent = class extends BaseComponent {
	constructor(..._args) {
		super(..._args);
		this.isV2 = false;
		this.defer = false;
		this.ephemeral = false;
		this.customIdParser = parseCustomId;
	}
	run(_interaction, _data) {}
};
var BaseModalComponent = class extends BaseComponent {};
//#endregion
//#region extensions/discord/src/internal/components.message.ts
var BaseButton = class extends BaseMessageInteractiveComponent {
	constructor(..._args) {
		super(..._args);
		this.type = ComponentType.Button;
		this.style = ButtonStyle.Primary;
		this.disabled = false;
	}
};
var Button = class extends BaseButton {
	serialize() {
		return clean$3({
			type: this.type,
			style: this.style,
			custom_id: this.customId,
			label: this.label,
			emoji: this.emoji,
			disabled: this.disabled || void 0
		});
	}
};
var LinkButton = class extends BaseButton {
	constructor(..._args2) {
		super(..._args2);
		this.customId = "";
		this.style = ButtonStyle.Link;
	}
	async run() {
		throw new Error("Link buttons do not run handlers");
	}
	serialize() {
		return clean$3({
			type: this.type,
			style: this.style,
			label: this.label,
			emoji: this.emoji,
			disabled: this.disabled || void 0,
			url: this.url
		});
	}
};
var AnySelectMenu = class extends BaseMessageInteractiveComponent {
	constructor(..._args3) {
		super(..._args3);
		this.disabled = false;
	}
	serialize() {
		return clean$3({
			...this.serializeOptions(),
			custom_id: this.customId,
			placeholder: this.placeholder,
			min_values: this.minValues,
			max_values: this.maxValues,
			disabled: this.disabled || void 0,
			required: this.required
		});
	}
};
var StringSelectMenu = class extends AnySelectMenu {
	constructor(..._args4) {
		super(..._args4);
		this.type = ComponentType.StringSelect;
	}
	serializeOptions() {
		return {
			type: this.type,
			options: this.options
		};
	}
};
var UserSelectMenu = class extends AnySelectMenu {
	constructor(..._args5) {
		super(..._args5);
		this.type = ComponentType.UserSelect;
	}
	serializeOptions() {
		return {
			type: this.type,
			default_values: this.defaultValues
		};
	}
};
var RoleSelectMenu = class extends AnySelectMenu {
	constructor(..._args6) {
		super(..._args6);
		this.type = ComponentType.RoleSelect;
	}
	serializeOptions() {
		return {
			type: this.type,
			default_values: this.defaultValues
		};
	}
};
var MentionableSelectMenu = class extends AnySelectMenu {
	constructor(..._args7) {
		super(..._args7);
		this.type = ComponentType.MentionableSelect;
	}
	serializeOptions() {
		return {
			type: this.type,
			default_values: this.defaultValues
		};
	}
};
var ChannelSelectMenu = class extends AnySelectMenu {
	constructor(..._args8) {
		super(..._args8);
		this.type = ComponentType.ChannelSelect;
	}
	serializeOptions() {
		return {
			type: this.type,
			default_values: this.defaultValues,
			channel_types: this.channelTypes
		};
	}
};
var Row = class extends BaseComponent {
	constructor(components = []) {
		super();
		this.type = ComponentType.ActionRow;
		this.isV2 = false;
		this.components = components;
	}
	addComponent(component) {
		this.components.push(component);
	}
	removeComponent(component) {
		this.components = this.components.filter((entry) => entry !== component);
	}
	removeAllComponents() {
		this.components = [];
	}
	serialize() {
		return {
			type: this.type,
			components: this.components.map((entry) => entry.serialize())
		};
	}
};
var TextDisplay = class extends BaseComponent {
	constructor(content) {
		super();
		this.content = content;
		this.type = ComponentType.TextDisplay;
		this.isV2 = true;
	}
	serialize() {
		return clean$3({
			type: this.type,
			content: this.content
		});
	}
};
var Separator = class extends BaseComponent {
	constructor(options) {
		super();
		this.type = ComponentType.Separator;
		this.isV2 = true;
		this.divider = true;
		this.spacing = "small";
		this.spacing = options?.spacing ?? this.spacing;
		this.divider = options?.divider ?? this.divider;
	}
	serialize() {
		return clean$3({
			type: this.type,
			divider: this.divider,
			spacing: this.spacing === "large" ? 2 : this.spacing === "small" ? 1 : this.spacing
		});
	}
};
var Thumbnail = class extends BaseComponent {
	constructor(url) {
		super();
		this.url = url;
		this.type = ComponentType.Thumbnail;
		this.isV2 = true;
	}
	serialize() {
		return clean$3({
			type: this.type,
			media: this.url ? { url: this.url } : void 0
		});
	}
};
var Section = class extends BaseComponent {
	constructor(components = [], accessory) {
		super();
		this.components = components;
		this.accessory = accessory;
		this.type = ComponentType.Section;
		this.isV2 = true;
	}
	serialize() {
		return clean$3({
			type: this.type,
			components: this.components.map((entry) => entry.serialize()),
			accessory: this.accessory?.serialize()
		});
	}
};
var MediaGallery = class extends BaseComponent {
	constructor(items = []) {
		super();
		this.items = items;
		this.type = ComponentType.MediaGallery;
		this.isV2 = true;
	}
	serialize() {
		return {
			type: this.type,
			items: this.items.map((entry) => ({
				media: { url: entry.url },
				description: entry.description,
				spoiler: entry.spoiler
			}))
		};
	}
};
var File = class extends BaseComponent {
	constructor(file, spoiler = false) {
		super();
		this.file = file;
		this.spoiler = spoiler;
		this.type = ComponentType.File;
		this.isV2 = true;
	}
	serialize() {
		return clean$3({
			type: this.type,
			file: this.file ? { url: this.file } : void 0,
			spoiler: this.spoiler || void 0
		});
	}
};
var Container = class extends BaseComponent {
	constructor(components = [], options) {
		super();
		this.type = ComponentType.Container;
		this.isV2 = true;
		this.spoiler = false;
		this.components = components;
		this.accentColor = options?.accentColor;
		this.spoiler = options?.spoiler ?? false;
	}
	serialize() {
		return clean$3({
			type: this.type,
			components: this.components.map((entry) => entry.serialize()),
			accent_color: colorToNumber(this.accentColor),
			spoiler: this.spoiler || void 0
		});
	}
};
//#endregion
//#region extensions/discord/src/internal/components.modal.ts
var TextInput = class extends BaseModalComponent {
	constructor(..._args) {
		super(..._args);
		this.type = ComponentType.TextInput;
		this.customIdParser = parseCustomId;
		this.style = TextInputStyle.Short;
	}
	serialize() {
		return clean$3({
			type: this.type,
			custom_id: this.customId,
			style: this.style,
			min_length: this.minLength,
			max_length: this.maxLength,
			required: this.required,
			value: this.value,
			placeholder: this.placeholder
		});
	}
};
var CheckboxGroup = class extends BaseModalComponent {
	constructor(..._args2) {
		super(..._args2);
		this.type = 22;
		this.options = [];
	}
	serialize() {
		return clean$3({
			type: this.type,
			custom_id: this.customId,
			options: this.options,
			required: this.required,
			min_values: this.minValues,
			max_values: this.maxValues
		});
	}
};
var RadioGroup = class extends BaseModalComponent {
	constructor(..._args3) {
		super(..._args3);
		this.type = 21;
		this.options = [];
	}
	serialize() {
		return clean$3({
			type: this.type,
			custom_id: this.customId,
			options: this.options,
			required: this.required,
			min_values: this.minValues,
			max_values: this.maxValues
		});
	}
};
var Label = class extends BaseModalComponent {
	constructor(component) {
		super();
		this.component = component;
		this.type = ComponentType.Label;
		this.customId = "";
	}
	serialize() {
		return clean$3({
			type: this.type,
			label: this.label,
			description: this.description,
			component: this.component?.serialize()
		});
	}
};
var Modal = class {
	constructor() {
		this.components = [];
		this.customIdParser = parseCustomId;
	}
	serialize() {
		return {
			title: this.title,
			custom_id: this.customId,
			components: this.components.map((entry) => entry.serialize())
		};
	}
};
//#endregion
//#region extensions/discord/src/internal/payload.ts
function clean$2(value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0));
}
function serializeAnyComponent(component) {
	return component.serialize();
}
function payloadHasV2Components(payload) {
	return Boolean(payload.components?.some((component) => component.isV2));
}
function normalizePayloadFlags(payload) {
	const flags = payload.ephemeral ? (payload.flags ?? 0) | MessageFlags.Ephemeral : payload.flags;
	if (!payloadHasV2Components(payload)) return flags;
	if (payload.content || payload.embeds?.length) throw new Error("Discord Components V2 payloads cannot include content or embeds");
	return (flags ?? 0) | MessageFlags.IsComponentsV2;
}
function serializePayload(payload) {
	if (typeof payload === "string") return { content: payload };
	const flags = normalizePayloadFlags(payload);
	return clean$2({
		content: payload.content,
		embeds: payload.embeds?.map((entry) => "serialize" in entry ? entry.serialize() : entry),
		components: payload.components?.map((entry) => serializeAnyComponent(entry)),
		allowed_mentions: payload.allowed_mentions ?? payload.allowedMentions,
		flags,
		tts: payload.tts,
		files: payload.files,
		poll: payload.poll,
		sticker_ids: payload.stickers
	});
}
//#endregion
//#region extensions/discord/src/internal/structures.ts
var Base = class {
	constructor(client) {
		this.client = client;
	}
};
var User = class extends Base {
	constructor(client, rawDataOrId) {
		super(client);
		this.rawDataValue = typeof rawDataOrId === "string" ? null : rawDataOrId;
		this.id = typeof rawDataOrId === "string" ? rawDataOrId : rawDataOrId.id;
	}
	get rawData() {
		if (!this.rawDataValue) throw new Error("Partial Discord user has no raw data");
		return this.rawDataValue;
	}
	get partial() {
		return this.rawDataValue === null;
	}
	get username() {
		return this.rawDataValue?.username ?? "";
	}
	get globalName() {
		return this.rawDataValue?.global_name;
	}
	get discriminator() {
		return this.rawDataValue?.discriminator;
	}
	get bot() {
		return this.rawDataValue?.bot;
	}
	get avatar() {
		return this.rawDataValue?.avatar;
	}
	get avatarUrl() {
		return this.avatar ? `https://cdn.discordapp.com/avatars/${this.id}/${this.avatar}.png` : null;
	}
	toString() {
		return `<@${this.id}>`;
	}
	async fetch() {
		return this.client.fetchUser(this.id);
	}
	async createDm() {
		return await createUserDmChannel(this.client.rest, this.id);
	}
	async send(data) {
		const dm = await this.createDm();
		const message = await createChannelMessage(this.client.rest, dm.id, { body: serializePayload(data) });
		return new Message(this.client, message);
	}
};
var Role = class extends Base {
	constructor(client, rawDataOrId) {
		super(client);
		this.rawDataValue = typeof rawDataOrId === "string" ? null : rawDataOrId;
		this.id = typeof rawDataOrId === "string" ? rawDataOrId : rawDataOrId.id;
	}
	get name() {
		return this.rawDataValue?.name ?? "";
	}
};
var Guild = class extends Base {
	constructor(client, rawDataOrId) {
		super(client);
		this.rawDataValue = typeof rawDataOrId === "string" ? null : rawDataOrId;
		this.id = typeof rawDataOrId === "string" ? rawDataOrId : rawDataOrId.id;
	}
	get name() {
		return this.rawDataValue?.name ?? "";
	}
};
var GuildMember = class extends Base {
	constructor(client, rawData) {
		super(client);
		this.rawData = rawData;
	}
	get user() {
		return this.rawData.user ? new User(this.client, this.rawData.user) : null;
	}
	get roles() {
		return this.rawData.roles ?? [];
	}
	get nickname() {
		return this.rawData.nick ?? void 0;
	}
};
var Message = class Message extends Base {
	constructor(client, rawDataOrIds) {
		super(client);
		this.rawDataValue = typeof rawDataOrIds === "string" || !("author" in rawDataOrIds) ? null : rawDataOrIds;
		this.id = typeof rawDataOrIds === "string" ? rawDataOrIds : rawDataOrIds.id;
		this.channelId = typeof rawDataOrIds === "string" ? "" : "channel_id" in rawDataOrIds ? rawDataOrIds.channel_id : rawDataOrIds.channelId ?? "";
	}
	get rawData() {
		if (!this.rawDataValue) throw new Error("Partial Discord message has no raw data");
		return this.rawDataValue;
	}
	get partial() {
		return this.rawDataValue === null;
	}
	get message() {
		return this;
	}
	get channel_id() {
		return this.channelId;
	}
	get guild_id() {
		return this.rawDataValue?.guild_id;
	}
	get guild() {
		return this.guild_id ? new Guild(this.client, this.guild_id) : null;
	}
	get webhookId() {
		return this.webhook_id;
	}
	get webhook_id() {
		return this.rawDataValue?.webhook_id ?? null;
	}
	get member() {
		const member = this.rawDataValue?.member;
		return member ? new GuildMember(this.client, member) : null;
	}
	get rawMember() {
		return this.rawDataValue?.member;
	}
	get content() {
		return this.rawDataValue?.content ?? "";
	}
	get author() {
		return this.rawDataValue?.author ? new User(this.client, this.rawDataValue.author) : null;
	}
	get embeds() {
		return this.rawDataValue?.embeds ?? [];
	}
	get attachments() {
		return this.rawDataValue?.attachments ?? [];
	}
	get stickers() {
		return this.rawDataValue?.sticker_items ?? [];
	}
	get mentionedUsers() {
		return (this.rawDataValue?.mentions ?? []).map((user) => new User(this.client, user));
	}
	get mentionedRoles() {
		return this.rawDataValue?.mention_roles ?? [];
	}
	get mentionedEveryone() {
		return this.rawDataValue?.mention_everyone ?? false;
	}
	get timestamp() {
		return this.rawDataValue?.timestamp;
	}
	get type() {
		return this.rawDataValue?.type;
	}
	get messageReference() {
		return this.rawDataValue?.message_reference;
	}
	get referencedMessage() {
		return this.rawDataValue?.referenced_message ? new Message(this.client, this.rawDataValue.referenced_message) : null;
	}
	get thread() {
		return this.rawDataValue?.thread ? channelFactory(this.client, this.rawDataValue.thread) : null;
	}
	async fetch() {
		const raw = await getChannelMessage(this.client.rest, this.channelId, this.id);
		return new Message(this.client, raw);
	}
	async delete() {
		await deleteChannelMessage(this.client.rest, this.channelId, this.id);
	}
	async edit(data) {
		const raw = await editChannelMessage(this.client.rest, this.channelId, this.id, { body: serializePayload(data) });
		return new Message(this.client, raw);
	}
	async reply(data) {
		const raw = await createChannelMessage(this.client.rest, this.channelId, { body: {
			...serializePayload(data),
			message_reference: {
				message_id: this.id,
				fail_if_not_exists: false
			}
		} });
		return new Message(this.client, raw);
	}
	async pin() {
		await pinChannelMessage(this.client.rest, this.channelId, this.id);
	}
	async unpin() {
		await unpinChannelMessage(this.client.rest, this.channelId, this.id);
	}
};
function channelFactory(clientForTest, channelData, _partial) {
	return {
		...channelData,
		rawData: channelData,
		guildId: "guild_id" in channelData ? channelData.guild_id : void 0,
		guild: "guild_id" in channelData && typeof channelData.guild_id === "string" ? new Guild(clientForTest, channelData.guild_id) : void 0,
		parentId: "parent_id" in channelData ? channelData.parent_id : void 0,
		ownerId: "owner_id" in channelData ? channelData.owner_id : void 0
	};
}
//#endregion
//#region extensions/discord/src/internal/entity-cache.ts
const DEFAULT_REST_CACHE_TTL_MS = 3e4;
var DiscordEntityCache = class {
	constructor(params) {
		this.params = params;
		this.entries = /* @__PURE__ */ new Map();
	}
	async fetchUser(id) {
		return await this.fetchCached(`user:${id}`, async () => {
			const raw = await getUser(this.rest, id);
			return new User(this.params.client, raw);
		});
	}
	async fetchChannel(id) {
		return await this.fetchCached(`channel:${id}`, async () => {
			const raw = await getChannel(this.rest, id);
			return channelFactory(this.params.client, raw);
		});
	}
	async fetchGuild(id) {
		return await this.fetchCached(`guild:${id}`, async () => {
			const raw = await getGuild(this.rest, id);
			return new Guild(this.params.client, raw);
		});
	}
	async fetchMember(guildId, userId) {
		return await this.fetchCached(`member:${guildId}:${userId}`, async () => {
			const raw = await getGuildMember(this.rest, guildId, userId);
			return new GuildMember(this.params.client, raw);
		});
	}
	invalidateForGatewayEvent(type, data) {
		const raw = data && typeof data === "object" ? data : {};
		const channelUpdate = GatewayDispatchEvents.ChannelUpdate;
		const channelDelete = GatewayDispatchEvents.ChannelDelete;
		const guildUpdate = GatewayDispatchEvents.GuildUpdate;
		const guildMemberUpdate = GatewayDispatchEvents.GuildMemberUpdate;
		if (type === channelUpdate || type === channelDelete) this.deleteId("channel", raw.id);
		if (type === guildUpdate) this.deleteId("guild", raw.id);
		if (type === guildMemberUpdate) {
			const guildId = raw.guild_id;
			const user = raw.user && typeof raw.user === "object" ? raw.user : {};
			if (typeof guildId === "string" && typeof user.id === "string") {
				this.entries.delete(`member:${guildId}:${user.id}`);
				this.entries.delete(`user:${user.id}`);
			}
		}
	}
	deleteId(prefix, id) {
		if (typeof id === "string") this.entries.delete(`${prefix}:${id}`);
	}
	async fetchCached(key, fetcher) {
		const ttl = this.params.ttlMs ?? DEFAULT_REST_CACHE_TTL_MS;
		if (ttl > 0) {
			const cached = this.entries.get(key);
			if (cached && cached.expiresAt > Date.now()) return cached.value;
		}
		const value = await fetcher();
		if (ttl > 0) this.entries.set(key, {
			expiresAt: Date.now() + ttl,
			value
		});
		return value;
	}
	get rest() {
		return typeof this.params.rest === "function" ? this.params.rest() : this.params.rest;
	}
};
//#endregion
//#region extensions/discord/src/internal/event-queue.ts
const DEFAULT_MAX_QUEUE_SIZE = 1e4;
const DEFAULT_MAX_CONCURRENCY = 50;
const DEFAULT_LISTENER_TIMEOUT_MS = 12e4;
const DEFAULT_SLOW_LISTENER_THRESHOLD_MS = 3e4;
var DiscordEventQueue = class {
	constructor(options = {}) {
		this.queue = [];
		this.queueHead = 0;
		this.processing = 0;
		this.processedCount = 0;
		this.droppedCount = 0;
		this.timeoutCount = 0;
		this.options = {
			maxQueueSize: normalizePositiveInteger(options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE),
			maxConcurrency: normalizePositiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
			listenerTimeout: normalizePositiveInteger(options.listenerTimeout, DEFAULT_LISTENER_TIMEOUT_MS),
			slowListenerThreshold: normalizePositiveInteger(options.slowListenerThreshold, DEFAULT_SLOW_LISTENER_THRESHOLD_MS)
		};
	}
	enqueue(params) {
		if (this.pendingQueueSize >= this.options.maxQueueSize) {
			this.droppedCount += 1;
			return Promise.reject(/* @__PURE__ */ new Error(`Discord event queue is full for ${params.eventType}; maxQueueSize=${this.options.maxQueueSize}`));
		}
		return new Promise((resolve, reject) => {
			this.queue.push({
				...params,
				resolve,
				reject
			});
			this.processNext();
		});
	}
	getMetrics() {
		return {
			queueSize: this.pendingQueueSize,
			processing: this.processing,
			processed: this.processedCount,
			dropped: this.droppedCount,
			timeouts: this.timeoutCount,
			maxQueueSize: this.options.maxQueueSize,
			maxConcurrency: this.options.maxConcurrency
		};
	}
	get pendingQueueSize() {
		return Math.max(0, this.queue.length - this.queueHead);
	}
	takeNextJob() {
		if (this.queueHead >= this.queue.length) {
			this.queue.length = 0;
			this.queueHead = 0;
			return;
		}
		const job = this.queue[this.queueHead];
		this.queueHead += 1;
		if (this.queueHead >= this.queue.length) {
			this.queue.length = 0;
			this.queueHead = 0;
		} else if (this.queueHead > 256 && this.queueHead * 2 > this.queue.length) {
			this.queue.splice(0, this.queueHead);
			this.queueHead = 0;
		}
		return job;
	}
	processNext() {
		while (this.processing < this.options.maxConcurrency && this.pendingQueueSize > 0) {
			const job = this.takeNextJob();
			if (!job) return;
			this.processing += 1;
			this.runJob(job).then(job.resolve, job.reject).finally(() => {
				this.processing -= 1;
				this.processedCount += 1;
				this.processNext();
			});
		}
	}
	async runJob(job) {
		const startedAt = Date.now();
		try {
			await this.runWithTimeout(job);
			this.logSlowListener(job, Date.now() - startedAt);
		} catch (error) {
			if (isListenerTimeoutError(error)) {
				this.timeoutCount += 1;
				console.error(`[EventQueue] Listener ${job.listenerName} timed out after ${this.options.listenerTimeout}ms for event ${job.eventType}`);
				return;
			}
			console.error(`[EventQueue] Listener ${job.listenerName} failed for event ${job.eventType}:`, error);
		}
	}
	async runWithTimeout(job) {
		let timeout;
		try {
			await Promise.race([job.run(), new Promise((_, reject) => {
				timeout = setTimeout(() => {
					reject(createListenerTimeoutError(this.options.listenerTimeout));
				}, this.options.listenerTimeout);
				timeout.unref?.();
			})]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
	logSlowListener(job, durationMs) {
		if (durationMs < this.options.slowListenerThreshold) return;
		console.warn(`[EventQueue] Slow listener detected: ${job.listenerName} took ${durationMs}ms for event ${job.eventType}`);
	}
};
function normalizePositiveInteger(value, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.max(1, Math.floor(value));
}
function createListenerTimeoutError(timeoutMs) {
	const error = /* @__PURE__ */ new Error(`Listener timeout after ${timeoutMs}ms`);
	error.name = "DiscordEventQueueListenerTimeoutError";
	return error;
}
function isListenerTimeoutError(error) {
	return error instanceof Error && error.name === "DiscordEventQueueListenerTimeoutError";
}
//#endregion
//#region extensions/discord/src/internal/commands.ts
function clean$1(value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0));
}
function resolveConditionalCommandOption(value, interaction) {
	return typeof value === "function" ? value(interaction) : value;
}
async function deferCommandInteractionIfNeeded(command, interaction) {
	if (!resolveConditionalCommandOption(command.defer, interaction)) return;
	await interaction.defer({ ephemeral: resolveConditionalCommandOption(command.ephemeral, interaction) });
}
function readRawCommandOptions(interaction) {
	const options = interaction.rawData.data?.options;
	return Array.isArray(options) ? options : [];
}
function findSelectedSubcommand(subcommands, interaction) {
	const subcommandName = readRawCommandOptions(interaction).find((option) => option.type === ApplicationCommandOptionType.Subcommand)?.name;
	return typeof subcommandName === "string" ? subcommands.find((command) => command.name === subcommandName) : void 0;
}
function findCommandOption(options, name) {
	if (!name) return;
	return options?.find((option) => option.name === name);
}
function hasCommandOptions(command) {
	return "options" in command;
}
function resolveFocusedCommandOptionAutocompleteHandler(command, interaction) {
	const focusedName = interaction.options.getFocused()?.name;
	const autocomplete = findCommandOption("subcommands" in command && Array.isArray(command.subcommands) ? findSelectedSubcommand(command.subcommands, interaction)?.options : hasCommandOptions(command) ? command.options : void 0, focusedName)?.autocomplete;
	return typeof autocomplete === "function" ? autocomplete : void 0;
}
var BaseCommand = class {
	constructor() {
		this.defer = false;
		this.ephemeral = false;
		this.integrationTypes = [0, 1];
		this.contexts = [
			InteractionContextType.Guild,
			InteractionContextType.BotDM,
			InteractionContextType.PrivateChannel
		];
	}
	serialize() {
		return clean$1({
			name: this.name,
			name_localizations: this.nameLocalizations,
			description: this.type === ApplicationCommandType.ChatInput ? this.description ?? "" : void 0,
			description_localizations: this.descriptionLocalizations,
			type: this.type,
			options: this.serializeOptions(),
			integration_types: this.integrationTypes,
			contexts: this.contexts,
			default_member_permissions: Array.isArray(this.permission) ? this.permission.reduce((sum, entry) => sum | entry, 0n).toString() : this.permission ? this.permission.toString() : null
		});
	}
};
var Command = class extends BaseCommand {
	constructor(..._args) {
		super(..._args);
		this.type = ApplicationCommandType.ChatInput;
	}
	async autocomplete(interaction) {
		throw new Error(`The ${interaction.rawData?.data?.name ?? this.name} command does not support autocomplete`);
	}
	async preCheck(interaction) {
		return Boolean(interaction) || true;
	}
	serializeOptions() {
		return this.options?.map((option) => {
			if (typeof option.autocomplete === "function") {
				const { autocomplete: _autocomplete, ...rest } = option;
				return {
					...rest,
					autocomplete: true
				};
			}
			return option;
		});
	}
};
var CommandWithSubcommands = class extends BaseCommand {
	constructor(..._args2) {
		super(..._args2);
		this.type = ApplicationCommandType.ChatInput;
	}
	async run(interaction) {
		const subcommand = findSelectedSubcommand(this.subcommands, interaction);
		if (!subcommand) {
			const subcommandName = readRawCommandOptions(interaction).find((option) => option.type === ApplicationCommandOptionType.Subcommand)?.name;
			throw new Error(`Unknown Discord subcommand: ${typeof subcommandName === "string" ? subcommandName : "<missing>"}`);
		}
		await deferCommandInteractionIfNeeded(subcommand, interaction);
		return await subcommand.run(interaction);
	}
	serializeOptions() {
		return this.subcommands.map((command) => clean$1({
			name: command.name,
			name_localizations: command.nameLocalizations,
			description: command.description ?? "",
			description_localizations: command.descriptionLocalizations,
			type: ApplicationCommandOptionType.Subcommand,
			options: command.serializeOptions()
		}));
	}
};
//#endregion
//#region extensions/discord/src/internal/interaction-options.ts
function readFocusedOption(options) {
	for (const option of options ?? []) {
		if ("focused" in option && option.focused) return option;
		const child = readFocusedOption(readChildOptions(option));
		if (child) return child;
	}
}
function findOption(options, name) {
	for (const option of options ?? []) {
		if (option.name === name) return option;
		const child = findOption(readChildOptions(option), name);
		if (child) return child;
	}
}
function readChildOptions(option) {
	if (!("options" in option) || !Array.isArray(option.options)) return;
	return option.options;
}
var OptionsHandler = class {
	constructor(rawOptions, client, resolvedChannels) {
		this.rawOptions = rawOptions;
		this.client = client;
		this.resolvedChannels = resolvedChannels;
	}
	getString(name) {
		const option = findOption(this.rawOptions, name);
		const value = option && "value" in option ? option.value : void 0;
		return typeof value === "string" ? value : null;
	}
	getNumber(name) {
		const option = findOption(this.rawOptions, name);
		const value = option && "value" in option ? option.value : void 0;
		return typeof value === "number" ? value : null;
	}
	getBoolean(name) {
		const option = findOption(this.rawOptions, name);
		const value = option && "value" in option ? option.value : void 0;
		return typeof value === "boolean" ? value : null;
	}
	async getChannel(name, required = false) {
		const option = findOption(this.rawOptions, name);
		const value = option && "value" in option ? option.value : void 0;
		const id = typeof value === "string" ? value : void 0;
		const resolved = id ? this.resolvedChannels?.[id] : void 0;
		if (resolved) return channelFactory(this.client, resolved);
		if (id) return await this.client.fetchChannel(id);
		if (required) throw new Error(`Missing required channel option ${name}`);
		return null;
	}
	getFocused() {
		return readFocusedOption(this.rawOptions);
	}
};
//#endregion
//#region extensions/discord/src/internal/interaction-response.ts
var InteractionResponseController = class {
	constructor() {
		this.state = "unacknowledged";
	}
	get acknowledged() {
		return this.state !== "unacknowledged";
	}
	recordCallback(type) {
		if (type === InteractionResponseType.DeferredChannelMessageWithSource) {
			this.state = "deferred";
			return;
		}
		if (type === InteractionResponseType.DeferredMessageUpdate) {
			this.state = "deferred-update";
			return;
		}
		this.state = "replied";
	}
	nextReplyAction() {
		if (this.state === "deferred" || this.state === "deferred-update") return "edit";
		if (this.state === "unacknowledged") return "initial";
		return "follow-up";
	}
	recordReplyEdit() {
		this.state = "replied";
	}
};
function needsComponentsV2Query(body) {
	return body !== null && typeof body === "object" && "flags" in body && typeof body.flags === "number" && (body.flags & MessageFlags.IsComponentsV2) !== 0;
}
//#endregion
//#region extensions/discord/src/internal/modal-fields.ts
function extractModalFields(components) {
	const out = {};
	for (const component of flattenModalComponents(components)) {
		const raw = component;
		if (typeof raw.custom_id !== "string") continue;
		if (Array.isArray(raw.values)) out[raw.custom_id] = raw.values.map(String);
		else if (typeof raw.value === "string" || typeof raw.value === "number" || typeof raw.value === "boolean") out[raw.custom_id] = String(raw.value);
	}
	return out;
}
function flattenModalComponents(components) {
	const out = [];
	for (const entry of components) {
		if (!entry || typeof entry !== "object") continue;
		const component = entry;
		if (component.component && typeof component.component === "object") out.push(component.component);
		if (Array.isArray(component.components)) out.push(...flattenModalComponents(component.components));
		out.push(entry);
	}
	return out;
}
var ModalFields = class {
	constructor(values, resolved, client) {
		this.values = values;
		this.resolved = resolved;
		this.client = client;
	}
	value(id, required) {
		const value = this.values[id];
		if (required && (value === void 0 || Array.isArray(value) && value.length === 0)) throw new Error(`Missing required modal field ${id}`);
		return value;
	}
	getText(id, required = false) {
		const value = this.value(id, required);
		return typeof value === "string" ? value : null;
	}
	getStringSelect(id, required = false) {
		const value = this.value(id, required);
		if (Array.isArray(value)) return value;
		return typeof value === "string" ? [value] : [];
	}
	getRoleSelect(id, required = false) {
		return this.getStringSelect(id, required).map((roleId) => {
			const raw = this.resolved?.roles?.[roleId];
			return raw ? new Role(this.client, {
				id: roleId,
				name: raw.name ?? ""
			}) : new Role(this.client, roleId);
		});
	}
	getUserSelect(id, required = false) {
		return this.getStringSelect(id, required).map((userId) => {
			const raw = this.resolved?.users?.[userId];
			return new User(this.client, {
				id: userId,
				username: raw?.username ?? ""
			});
		});
	}
};
//#endregion
//#region extensions/discord/src/internal/schemas.ts
const discordInteractionPayloadSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	token: Type.String({ minLength: 1 }),
	type: Type.Number()
}, { additionalProperties: true });
const discordRateLimitBodySchema = Type.Object({
	message: Type.Optional(Type.String()),
	retry_after: Type.Optional(Type.Union([Type.Number(), Type.String()])),
	global: Type.Optional(Type.Boolean()),
	code: Type.Optional(Type.Union([Type.Number(), Type.String()]))
}, { additionalProperties: true });
function assertDiscordInteractionPayload(value) {
	if (!Check(discordInteractionPayloadSchema, value)) throw new Error("Invalid Discord interaction payload");
}
function isDiscordRateLimitBody(value) {
	return Check(discordRateLimitBodySchema, value);
}
//#endregion
//#region extensions/discord/src/internal/interactions.ts
function toCommandRawInteraction(rawData) {
	return rawData;
}
function toMessageComponentRawInteraction(rawData) {
	return rawData;
}
function toModalSubmitRawInteraction(rawData) {
	return rawData;
}
function readInteractionUser(rawData, client) {
	const directUser = "user" in rawData ? rawData.user : void 0;
	if (directUser && typeof directUser === "object" && "id" in directUser) return new User(client, directUser);
	const memberUser = rawData.member?.user;
	if (memberUser && typeof memberUser === "object" && typeof memberUser.id === "string") {
		const user = { ...memberUser };
		if (typeof user.username !== "string") user.username = "";
		return new User(client, user);
	}
	return null;
}
var BaseInteraction = class {
	constructor(client, rawData) {
		this.client = client;
		this.rawData = rawData;
		this.message = null;
		this.response = new InteractionResponseController();
		this.id = rawData.id;
		this.token = rawData.token;
		this.user = readInteractionUser(rawData, client);
		this.userId = this.user?.id ?? "";
		this.guild = rawData.guild_id ? new Guild(client, rawData.guild_id) : null;
		this.channel = "channel" in rawData && rawData.channel ? channelFactory(client, rawData.channel) : null;
	}
	get acknowledged() {
		return this.response.acknowledged;
	}
	get responseState() {
		return this.response.state;
	}
	set responseState(nextState) {
		this.response.state = nextState;
	}
	async callback(type, data) {
		this.response.recordCallback(type);
		return await createInteractionCallback(this.client.rest, this.id, this.token, data === void 0 ? { type } : {
			type,
			data
		});
	}
	async reply(payload) {
		const action = this.response.nextReplyAction();
		if (action === "edit") return await this.editReply(payload);
		if (action === "follow-up") return await this.followUp(payload);
		return await this.callback(InteractionResponseType.ChannelMessageWithSource, serializePayload(payload));
	}
	async defer(options) {
		return await this.callback(InteractionResponseType.DeferredChannelMessageWithSource, options?.ephemeral ? { flags: 64 } : void 0);
	}
	async acknowledge() {
		return await this.defer();
	}
	async editReply(payload) {
		const body = serializePayload(payload);
		const query = needsComponentsV2Query(body) ? { with_components: true } : void 0;
		const result = query ? await editWebhookMessage(this.client.rest, this.client.options.clientId, this.token, "@original", { body }, query) : await editWebhookMessage(this.client.rest, this.client.options.clientId, this.token, "@original", { body });
		this.response.recordReplyEdit();
		return result;
	}
	async deleteReply() {
		return await deleteWebhookMessage(this.client.rest, this.client.options.clientId, this.token, "@original");
	}
	async fetchReply() {
		return await getWebhookMessage(this.client.rest, this.client.options.clientId, this.token, "@original");
	}
	async replyAndWaitForComponent(payload, timeoutMs = 3e5) {
		const result = await this.reply(payload);
		const rawMessage = isRawMessage(result) ? result : await this.fetchReply();
		if (!isRawMessage(rawMessage)) throw new Error("Discord interaction reply did not return a message");
		const message = new Message(this.client, rawMessage);
		return await this.client.componentHandler.waitForMessageComponent(message, timeoutMs);
	}
	async followUp(payload) {
		const body = serializePayload(payload);
		return await createWebhookMessage(this.client.rest, this.client.options.clientId, this.token, { body }, needsComponentsV2Query(body) ? { with_components: true } : void 0);
	}
};
var CommandInteraction = class extends BaseInteraction {
	constructor(client, rawData) {
		super(client, rawData);
		this.options = new OptionsHandler(rawData.data.options, client, rawData.data.resolved?.channels);
	}
};
var AutocompleteInteraction = class extends CommandInteraction {
	async respond(choices) {
		return await this.callback(InteractionResponseType.ApplicationCommandAutocompleteResult, { choices });
	}
};
var BaseComponentInteraction = class extends BaseInteraction {
	constructor(client, rawData) {
		super(client, rawData);
		this.message = rawData.message && typeof rawData.message === "object" ? new Message(client, rawData.message) : null;
		this.values = Array.isArray(rawData.data.values) ? rawData.data.values.map(String) : [];
	}
	async update(payload) {
		return await this.callback(InteractionResponseType.UpdateMessage, serializePayload(payload));
	}
	async acknowledge() {
		return await this.callback(InteractionResponseType.DeferredMessageUpdate);
	}
	async showModal(modal) {
		return await this.callback(InteractionResponseType.Modal, modal.serialize());
	}
	async editAndWaitForComponent(payload, message = this.message, timeoutMs = 3e5) {
		if (!message) return null;
		const editedMessage = await message.edit(payload);
		return await this.client.componentHandler.waitForMessageComponent(editedMessage, timeoutMs);
	}
};
var ButtonInteraction = class extends BaseComponentInteraction {};
var StringSelectMenuInteraction = class extends BaseComponentInteraction {};
var UserSelectMenuInteraction = class extends BaseComponentInteraction {};
var RoleSelectMenuInteraction = class extends BaseComponentInteraction {};
var MentionableSelectMenuInteraction = class extends BaseComponentInteraction {};
var ChannelSelectMenuInteraction = class extends BaseComponentInteraction {};
var ModalInteraction = class extends BaseInteraction {
	constructor(client, rawData) {
		super(client, rawData);
		this.fields = new ModalFields(extractModalFields(rawData.data.components ?? []), rawData.data.resolved, client);
	}
	async acknowledge() {
		return await this.callback(InteractionResponseType.DeferredMessageUpdate);
	}
};
function createInteraction(client, rawData) {
	assertDiscordInteractionPayload(rawData);
	if (rawData.type === InteractionType.ApplicationCommandAutocomplete) return new AutocompleteInteraction(client, toCommandRawInteraction(rawData));
	if (rawData.type === InteractionType.ApplicationCommand) return new CommandInteraction(client, toCommandRawInteraction(rawData));
	if (rawData.type === InteractionType.ModalSubmit) return new ModalInteraction(client, toModalSubmitRawInteraction(rawData));
	if (rawData.type === InteractionType.MessageComponent) {
		const componentRawData = toMessageComponentRawInteraction(rawData);
		switch (rawData.data?.component_type) {
			case ComponentType.Button: return new ButtonInteraction(client, componentRawData);
			case ComponentType.StringSelect: return new StringSelectMenuInteraction(client, componentRawData);
			case ComponentType.UserSelect: return new UserSelectMenuInteraction(client, componentRawData);
			case ComponentType.RoleSelect: return new RoleSelectMenuInteraction(client, componentRawData);
			case ComponentType.MentionableSelect: return new MentionableSelectMenuInteraction(client, componentRawData);
			case ComponentType.ChannelSelect: return new ChannelSelectMenuInteraction(client, componentRawData);
			default: return new BaseComponentInteraction(client, componentRawData);
		}
	}
	return new BaseInteraction(client, rawData);
}
function parseComponentInteractionData(component, customId) {
	return component.customIdParser(customId).data;
}
function isRawMessage(value) {
	return Boolean(value) && typeof value === "object" && typeof value.id === "string" && typeof value.channel_id === "string";
}
//#endregion
//#region extensions/discord/src/internal/interaction-dispatch.ts
async function dispatchInteraction(client, rawData) {
	const interaction = createInteraction(client, rawData);
	if (rawData.type === InteractionType.ApplicationCommandAutocomplete) {
		const command = client.commands.find((entry) => entry.name === readInteractionName(rawData));
		if (!command) return;
		const autocompleteInteraction = interaction;
		const optionAutocomplete = resolveFocusedCommandOptionAutocompleteHandler(command, autocompleteInteraction);
		if (optionAutocomplete) {
			await optionAutocomplete(autocompleteInteraction);
			return;
		}
		if ("autocomplete" in command) await command.autocomplete(autocompleteInteraction);
		return;
	}
	if (rawData.type === InteractionType.ApplicationCommand) {
		const command = client.commands.find((entry) => entry.name === readInteractionName(rawData));
		if (command && "run" in command) {
			await deferCommandInteractionIfNeeded(command, interaction);
			await command.run(interaction);
		}
		return;
	}
	if (rawData.type === InteractionType.MessageComponent) {
		const customId = readCustomId(rawData);
		if (!customId) return;
		const componentInteraction = interaction;
		if (client.componentHandler.resolveOneOffComponent({
			channelId: readMessageChannelId(rawData),
			customId,
			messageId: readMessageId(rawData),
			values: readComponentValues(rawData)
		})) {
			await componentInteraction.acknowledge();
			return;
		}
		const component = client.componentHandler.resolve(customId, { componentType: rawData.data?.component_type });
		if (component) {
			await deferComponentInteractionIfNeeded(component, componentInteraction);
			await component.run(componentInteraction, parseComponentInteractionData(component, customId));
		}
		return;
	}
	if (rawData.type === InteractionType.ModalSubmit) {
		const customId = readCustomId(rawData);
		if (!customId) return;
		const modal = client.modalHandler.resolve(customId);
		if (modal) await modal.run(interaction, modal.customIdParser(customId).data);
	}
}
function resolveConditionalComponentOption(value, interaction) {
	return typeof value === "function" ? value(interaction) : value;
}
async function deferComponentInteractionIfNeeded(component, interaction) {
	if (!resolveConditionalComponentOption(component.defer, interaction)) return;
	if (resolveConditionalComponentOption(component.ephemeral, interaction)) {
		await interaction.defer({ ephemeral: true });
		return;
	}
	await interaction.acknowledge();
}
function readInteractionName(rawData) {
	return rawData.data?.name;
}
function readCustomId(rawData) {
	return rawData.data?.custom_id;
}
function readComponentValues(rawData) {
	const values = rawData.data?.values;
	return Array.isArray(values) ? values.map(String) : void 0;
}
function readMessageId(rawData) {
	const messageId = rawData.message?.id;
	return typeof messageId === "string" ? messageId : void 0;
}
function readMessageChannelId(rawData) {
	const channelId = rawData.message?.channel_id;
	return typeof channelId === "string" ? channelId : void 0;
}
//#endregion
//#region extensions/discord/src/internal/rest-body.ts
function serializeRequestBody(data, headers) {
	if (data?.headers) for (const [key, value] of Object.entries(data.headers)) headers.set(key, value);
	if (data?.body == null) return;
	if (typeof data.body === "object") {
		const bodyObject = data.body;
		const topLevelFiles = Array.isArray(bodyObject.files) ? bodyObject.files : void 0;
		const nestedData = bodyObject.data && typeof bodyObject.data === "object" ? bodyObject.data : void 0;
		const nestedFiles = nestedData && Array.isArray(nestedData.files) ? nestedData.files : void 0;
		const files = topLevelFiles ?? nestedFiles;
		const filesContainer = topLevelFiles ? bodyObject : nestedFiles ? nestedData : void 0;
		if (files?.length && filesContainer) {
			if (data.multipartStyle === "form") {
				const formData = new FormData();
				for (const [key, value] of Object.entries(filesContainer)) {
					if (key === "files" || value === void 0 || value === null) continue;
					formData.append(key, typeof value === "string" ? value : JSON.stringify(value));
				}
				for (const file of files) {
					const item = file;
					const name = typeof item.name === "string" && item.name ? item.name : "file";
					const blob = item.data instanceof Blob ? item.data : new Blob([item.data], { type: typeof item.contentType === "string" ? item.contentType : void 0 });
					formData.append(typeof item.fieldName === "string" && item.fieldName ? item.fieldName : "file", blob, name);
				}
				return formData;
			}
			const payloadJson = topLevelFiles ? { ...bodyObject } : {
				...bodyObject,
				data: { ...nestedData }
			};
			const payloadFilesContainer = topLevelFiles ? payloadJson : payloadJson.data ?? {};
			const formData = new FormData();
			const existingAttachments = Array.isArray(payloadFilesContainer.attachments) ? [...payloadFilesContainer.attachments] : [];
			const uploaded = files.map((file, index) => {
				const item = file;
				const name = typeof item.name === "string" && item.name ? item.name : `file-${index}`;
				const blob = item.data instanceof Blob ? item.data : new Blob([item.data], { type: typeof item.contentType === "string" ? item.contentType : void 0 });
				const id = existingAttachments.length + index;
				formData.append(`files[${id}]`, blob, name);
				const attachment = {
					id,
					filename: name
				};
				if (typeof item.description === "string") attachment.description = item.description;
				if (typeof item.duration_secs === "number") attachment.duration_secs = item.duration_secs;
				if (typeof item.waveform === "string") attachment.waveform = item.waveform;
				return attachment;
			});
			payloadFilesContainer.attachments = [...existingAttachments, ...uploaded];
			delete payloadFilesContainer.files;
			formData.append("payload_json", JSON.stringify(payloadJson));
			return formData;
		}
	}
	if (!data.rawBody) headers.set("Content-Type", "application/json");
	return data.rawBody ? data.body : JSON.stringify(data.body);
}
//#endregion
//#region extensions/discord/src/internal/rest-errors.ts
function readDiscordCode(body) {
	const value = body && typeof body === "object" && "code" in body ? body.code : void 0;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
}
function readDiscordMessage(body, fallback) {
	const value = body && typeof body === "object" && "message" in body ? body.message : void 0;
	return typeof value === "string" && value.trim() ? value : fallback;
}
function readRetryAfterHeader(value, now = Date.now()) {
	if (!value) return;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return seconds;
	const retryAt = Date.parse(value);
	return Number.isFinite(retryAt) ? (retryAt - now) / 1e3 : void 0;
}
function coerceRetryAfterSeconds(value) {
	if (typeof value !== "number" && typeof value !== "string") return;
	const seconds = typeof value === "number" ? value : Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.max(0, seconds) : void 0;
}
function readRetryAfter(body, response, fallbackSeconds = 0) {
	return coerceRetryAfterSeconds(body && typeof body === "object" && "retry_after" in body ? body.retry_after : void 0) ?? coerceRetryAfterSeconds(readRetryAfterHeader(response.headers.get("Retry-After"))) ?? fallbackSeconds;
}
var DiscordError = class extends Error {
	constructor(response, body) {
		super(readDiscordMessage(body, `Discord API request failed (${response.status})`));
		this.name = "DiscordError";
		this.status = response.status;
		this.statusCode = response.status;
		this.rawBody = body;
		this.rawError = body;
		this.discordCode = readDiscordCode(body);
	}
};
var RateLimitError = class extends DiscordError {
	constructor(response, body) {
		super(response, body);
		this.name = "RateLimitError";
		this.retryAfter = readRetryAfter(body, response, 1);
		this.scope = body.global ? "global" : response.headers.get("X-RateLimit-Scope");
		this.bucket = response.headers.get("X-RateLimit-Bucket");
	}
};
//#endregion
//#region extensions/discord/src/internal/rest-routes.ts
function createRouteKey(method, path) {
	return `${method.toUpperCase()} ${path.split("?")[0] ?? path}`;
}
function readTopLevelRouteKey(path) {
	const [pathname = path] = path.split("?");
	const [first, id, token] = pathname.replace(/^\/+/, "").split("/");
	if (!first || !id) return pathname;
	if (first === "channels" || first === "guilds" || first === "webhooks") return first === "webhooks" && token ? `${first}/${id}/${token}` : `${first}/${id}`;
	return first;
}
function createBucketKey(bucket, path) {
	return `${bucket}:${readTopLevelRouteKey(path)}`;
}
function readHeaderNumber(headers, name) {
	const value = headers.get(name);
	if (!value) return;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function readResetAt(response) {
	const resetAfter = readHeaderNumber(response.headers, "X-RateLimit-Reset-After");
	if (resetAfter !== void 0) return Date.now() + Math.max(0, resetAfter * 1e3);
	const reset = readHeaderNumber(response.headers, "X-RateLimit-Reset");
	return reset !== void 0 ? reset * 1e3 : void 0;
}
function appendQuery(path, query) {
	if (!query || Object.keys(query).length === 0) return path;
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) search.set(key, String(value));
	return `${path}?${search.toString()}`;
}
//#endregion
//#region extensions/discord/src/internal/rest-scheduler.ts
const INVALID_REQUEST_WINDOW_MS = 10 * 6e4;
const requestPriorities = [
	"critical",
	"standard",
	"background"
];
function createLaneQueues() {
	return {
		critical: [],
		standard: [],
		background: []
	};
}
function countPending(bucket) {
	return requestPriorities.reduce((count, lane) => count + bucket.pending[lane].length, 0);
}
var RestScheduler = class {
	constructor(options, executor) {
		this.options = options;
		this.executor = executor;
		this.activeWorkers = 0;
		this.buckets = /* @__PURE__ */ new Map();
		this.globalRateLimitUntil = 0;
		this.invalidRequestTimestamps = [];
		this.laneCursor = 0;
		this.laneDropped = {
			critical: 0,
			standard: 0,
			background: 0
		};
		this.queuedByLane = {
			critical: 0,
			standard: 0,
			background: 0
		};
		this.queueGeneration = 0;
		this.queuedRequests = 0;
		this.routeBuckets = /* @__PURE__ */ new Map();
		this.laneSchedule = this.buildLaneSchedule(options.lanes);
	}
	enqueue(params) {
		if (this.queuedRequests >= this.options.maxQueueSize) throw new Error("Discord request queue is full");
		const laneOptions = this.options.lanes[params.priority];
		if (this.queuedByLane[params.priority] >= laneOptions.maxQueueSize) {
			this.laneDropped[params.priority] += 1;
			throw new Error(`Discord ${params.priority} request queue is full (${this.queuedByLane[params.priority]} / ${laneOptions.maxQueueSize})`);
		}
		const routeKey = createRouteKey(params.method, params.path);
		const bucket = this.getBucket(this.routeBuckets.get(routeKey) ?? routeKey);
		return new Promise((resolve, reject) => {
			this.queuedRequests += 1;
			this.queuedByLane[params.priority] += 1;
			bucket.pending[params.priority].push({
				...params,
				enqueuedAt: Date.now(),
				generation: this.queueGeneration,
				routeKey,
				retryCount: 0,
				resolve,
				reject
			});
			this.drainQueues();
		});
	}
	recordResponse(routeKey, path, response, parsed) {
		this.updateRateLimitState(routeKey, path, response, parsed);
		this.recordInvalidRequest(routeKey, path, response);
	}
	clearQueue() {
		this.queueGeneration += 1;
		if (this.drainTimer) {
			clearTimeout(this.drainTimer);
			this.drainTimer = void 0;
		}
		this.rejectPending(/* @__PURE__ */ new Error("Discord request queue cleared"));
	}
	abortPending() {
		this.queueGeneration += 1;
		this.rejectPending(new DOMException("Aborted", "AbortError"));
	}
	get queueSize() {
		return this.queuedRequests;
	}
	getMetrics() {
		this.pruneInvalidRequests();
		return {
			globalRateLimitUntil: this.globalRateLimitUntil,
			activeBuckets: this.buckets.size,
			routeBucketMappings: this.routeBuckets.size,
			buckets: Array.from(this.buckets.entries()).map(([key, bucket]) => ({
				key,
				active: bucket.active,
				bucket: bucket.bucket,
				invalidRequests: bucket.invalidRequests,
				pending: countPending(bucket),
				pendingByLane: Object.fromEntries(requestPriorities.map((lane) => [lane, bucket.pending[lane].length])),
				rateLimitHits: bucket.rateLimitHits,
				remaining: bucket.remaining,
				resetAt: bucket.resetAt,
				routeKeyCount: bucket.routeKeys.size
			})),
			invalidRequestCount: this.invalidRequestTimestamps.length,
			invalidRequestCountByStatus: this.invalidRequestTimestamps.reduce((counts, entry) => {
				counts[entry.status] = (counts[entry.status] ?? 0) + 1;
				return counts;
			}, {}),
			queueSize: this.queueSize,
			queueSizeByLane: { ...this.queuedByLane },
			droppedByLane: { ...this.laneDropped },
			oldestQueuedByLane: Object.fromEntries(requestPriorities.map((lane) => [lane, this.getOldestQueuedAge(lane)])),
			activeWorkers: this.activeWorkers,
			maxConcurrentWorkers: this.maxConcurrentWorkers
		};
	}
	get maxConcurrentWorkers() {
		return Math.max(1, Math.floor(this.options.maxConcurrency));
	}
	get maxRateLimitRetries() {
		return Math.max(0, Math.floor(this.options.maxRateLimitRetries));
	}
	getBucket(key) {
		const existing = this.buckets.get(key);
		if (existing) return existing;
		const bucket = {
			active: 0,
			invalidRequests: 0,
			pending: createLaneQueues(),
			rateLimitHits: 0,
			resetAt: 0,
			routeKeys: new Set([key])
		};
		this.buckets.set(key, bucket);
		return bucket;
	}
	hasBucketReference(key) {
		for (const bucketKey of this.routeBuckets.values()) if (bucketKey === key) return true;
		return false;
	}
	isBucketRateLimited(bucket, now = Date.now()) {
		return bucket.remaining === 0 && bucket.resetAt > now;
	}
	pruneRouteMapping(routeKey) {
		const bucketKey = this.routeBuckets.get(routeKey);
		if (!bucketKey) return;
		this.routeBuckets.delete(routeKey);
		this.buckets.get(bucketKey)?.routeKeys.delete(routeKey);
	}
	pruneIdleRouteMappings(bucketKey, bucket, now = Date.now()) {
		if (bucket.active > 0 || countPending(bucket) > 0 || this.isBucketRateLimited(bucket, now)) return;
		for (const routeKey of Array.from(bucket.routeKeys)) if (this.routeBuckets.get(routeKey) === bucketKey) this.pruneRouteMapping(routeKey);
	}
	shouldPruneIdleBucket(key) {
		return this.routeBuckets.get(key) !== key && !this.hasBucketReference(key);
	}
	bindRouteToBucket(routeKey, bucketKey) {
		const target = this.getBucket(bucketKey);
		target.routeKeys.add(routeKey);
		this.routeBuckets.set(routeKey, bucketKey);
		const routeBucket = this.buckets.get(routeKey);
		if (routeBucket && routeBucket !== target) {
			for (const lane of requestPriorities) {
				target.pending[lane].push(...routeBucket.pending[lane]);
				routeBucket.pending[lane] = [];
			}
			if (routeBucket.active === 0) this.buckets.delete(routeKey);
		}
		return target;
	}
	updateRateLimitState(routeKey, path, response, parsed) {
		const bucketHeader = response.headers.get("X-RateLimit-Bucket");
		const bucket = bucketHeader ? this.bindRouteToBucket(routeKey, createBucketKey(bucketHeader, path)) : this.getBucket(this.routeBuckets.get(routeKey) ?? routeKey);
		bucket.bucket = bucketHeader ?? bucket.bucket;
		const limit = readHeaderNumber(response.headers, "X-RateLimit-Limit");
		if (limit !== void 0) bucket.limit = limit;
		const remaining = readHeaderNumber(response.headers, "X-RateLimit-Remaining");
		if (remaining !== void 0) bucket.remaining = remaining;
		const resetAt = readResetAt(response);
		if (resetAt !== void 0) bucket.resetAt = resetAt;
		if (response.status !== 429) return;
		bucket.rateLimitHits += 1;
		const retryAfterMs = Math.max(0, readRetryAfter(parsed, response, 1) * 1e3);
		const retryAt = Date.now() + retryAfterMs;
		if (response.headers.get("X-RateLimit-Global") === "true" || isGlobalRateLimit(parsed)) {
			this.globalRateLimitUntil = Math.max(this.globalRateLimitUntil, retryAt);
			return;
		}
		bucket.remaining = 0;
		bucket.resetAt = Math.max(bucket.resetAt, retryAt);
	}
	recordInvalidRequest(routeKey, path, response) {
		if (response.status !== 401 && response.status !== 403 && response.status !== 429) return;
		if (response.status === 429 && response.headers.get("X-RateLimit-Scope") === "shared") return;
		const now = Date.now();
		this.invalidRequestTimestamps.push({
			at: now,
			status: response.status
		});
		this.pruneInvalidRequests(now);
		const bucketHeader = response.headers.get("X-RateLimit-Bucket");
		const bucketKey = bucketHeader ? createBucketKey(bucketHeader, path) : this.routeBuckets.get(routeKey) ?? routeKey;
		const bucket = this.buckets.get(bucketKey);
		if (bucket) bucket.invalidRequests += 1;
	}
	pruneInvalidRequests(now = Date.now()) {
		const cutoff = now - INVALID_REQUEST_WINDOW_MS;
		while (this.invalidRequestTimestamps.length > 0 && (this.invalidRequestTimestamps[0]?.at ?? 0) <= cutoff) this.invalidRequestTimestamps.shift();
	}
	getBucketWaitMs(bucket, now) {
		if (bucket.remaining === 0 && bucket.resetAt > now) return bucket.resetAt - now;
		if (bucket.remaining === 0 && bucket.resetAt <= now) bucket.remaining = bucket.limit;
		return 0;
	}
	scheduleDrain(delayMs = 0) {
		if (this.drainTimer) return;
		this.drainTimer = setTimeout(() => {
			this.drainTimer = void 0;
			this.drainQueues();
		}, Math.max(0, delayMs));
		this.drainTimer.unref?.();
	}
	drainQueues() {
		let nextDelayMs = Number.POSITIVE_INFINITY;
		while (this.activeWorkers < this.maxConcurrentWorkers) {
			const next = this.takeNextQueuedRequest();
			if (!next.queued) {
				if (next.waitMs !== void 0) nextDelayMs = Math.min(nextDelayMs, next.waitMs);
				break;
			}
			const { bucket, queued } = next;
			if (bucket.remaining !== void 0 && bucket.remaining > 0) bucket.remaining -= 1;
			bucket.active += 1;
			this.activeWorkers += 1;
			this.runQueuedRequest(queued, bucket);
		}
		if (Number.isFinite(nextDelayMs)) this.scheduleDrain(nextDelayMs);
	}
	takeNextQueuedRequest() {
		const now = Date.now();
		if (this.globalRateLimitUntil > now) return { waitMs: this.globalRateLimitUntil - now };
		this.pruneIdleBuckets(now);
		let nextDelayMs;
		const buckets = Array.from(this.buckets.values()).filter((bucket) => countPending(bucket) > 0);
		if (buckets.length === 0) return {};
		for (let laneOffset = 0; laneOffset < this.laneSchedule.length; laneOffset += 1) {
			const lane = this.laneSchedule[(this.laneCursor + laneOffset) % this.laneSchedule.length];
			if (!lane || this.queuedByLane[lane] <= 0) continue;
			for (const bucket of buckets) {
				const queue = bucket.pending[lane];
				this.dropStaleHeadRequests(queue, lane, now);
				if (queue.length === 0) continue;
				if (bucket.active > 0) continue;
				const waitMs = this.getBucketWaitMs(bucket, now);
				if (waitMs > 0) {
					nextDelayMs = Math.min(nextDelayMs ?? waitMs, waitMs);
					continue;
				}
				const queued = queue.shift();
				if (!queued) continue;
				this.queuedByLane[lane] = Math.max(0, this.queuedByLane[lane] - 1);
				this.laneCursor = (this.laneCursor + laneOffset + 1) % this.laneSchedule.length;
				return {
					bucket,
					queued
				};
			}
		}
		return { waitMs: nextDelayMs };
	}
	dropStaleHeadRequests(queue, lane, now) {
		if (lane !== "background") return;
		const staleAfterMs = this.options.lanes[lane].staleAfterMs;
		if (!staleAfterMs || staleAfterMs <= 0) return;
		while (queue.length > 0 && now - (queue[0]?.enqueuedAt ?? now) > staleAfterMs) {
			const stale = queue.shift();
			if (!stale) continue;
			this.queuedRequests = Math.max(0, this.queuedRequests - 1);
			this.queuedByLane[lane] = Math.max(0, this.queuedByLane[lane] - 1);
			this.laneDropped[lane] += 1;
			stale.reject(/* @__PURE__ */ new Error(`Dropped stale ${lane} request after ${now - stale.enqueuedAt}ms`));
		}
	}
	pruneIdleBuckets(now = Date.now()) {
		for (const [key, bucket] of this.buckets) {
			if (bucket.active !== 0 || countPending(bucket) > 0) continue;
			if (this.isBucketRateLimited(bucket, now)) continue;
			this.pruneIdleRouteMappings(key, bucket, now);
			if (this.shouldPruneIdleBucket(key)) this.buckets.delete(key);
		}
	}
	async runQueuedRequest(queued, bucket) {
		let requeued = false;
		try {
			queued.resolve(await this.executor(queued));
		} catch (error) {
			if (error instanceof RateLimitError && this.requeueRateLimitedRequest(queued)) {
				requeued = true;
				return;
			}
			queued.reject(error);
		} finally {
			bucket.active = Math.max(0, bucket.active - 1);
			this.activeWorkers = Math.max(0, this.activeWorkers - 1);
			if (!requeued) this.queuedRequests = Math.max(0, this.queuedRequests - 1);
			if (bucket.active === 0 && countPending(bucket) === 0) {
				for (const routeKey of bucket.routeKeys) if (this.routeBuckets.get(routeKey) === routeKey) this.routeBuckets.delete(routeKey);
			}
			this.drainQueues();
		}
	}
	requeueRateLimitedRequest(queued) {
		if (queued.generation !== this.queueGeneration || queued.retryCount >= this.maxRateLimitRetries) return false;
		const bucketKey = this.routeBuckets.get(queued.routeKey) ?? queued.routeKey;
		this.getBucket(bucketKey).pending[queued.priority].push({
			...queued,
			enqueuedAt: Date.now(),
			retryCount: queued.retryCount + 1
		});
		this.queuedByLane[queued.priority] += 1;
		return true;
	}
	rejectPending(error) {
		for (const bucket of this.buckets.values()) for (const lane of requestPriorities) for (const queued of bucket.pending[lane].splice(0)) {
			queued.reject(error);
			this.queuedRequests = Math.max(0, this.queuedRequests - 1);
			this.queuedByLane[lane] = Math.max(0, this.queuedByLane[lane] - 1);
		}
	}
	buildLaneSchedule(lanes) {
		const schedule = [];
		for (const lane of requestPriorities) {
			const weight = Math.max(1, Math.floor(lanes[lane].weight));
			for (let i = 0; i < weight; i += 1) schedule.push(lane);
		}
		return schedule.length > 0 ? schedule : [...requestPriorities];
	}
	getOldestQueuedAge(lane) {
		const now = Date.now();
		let oldest = 0;
		for (const bucket of this.buckets.values()) {
			const queued = bucket.pending[lane][0];
			if (!queued) continue;
			oldest = Math.max(oldest, now - queued.enqueuedAt);
		}
		return oldest;
	}
};
function isGlobalRateLimit(parsed) {
	return parsed && typeof parsed === "object" && "global" in parsed ? Boolean(parsed.global) : false;
}
//#endregion
//#region extensions/discord/src/internal/rest.ts
const defaultOptions = {
	tokenHeader: "Bot",
	baseUrl: "https://discord.com/api",
	apiVersion: 10,
	userAgent: "OpenClaw Discord",
	timeout: 15e3,
	queueRequests: true,
	maxQueueSize: 1e3,
	runtimeProfile: "persistent"
};
const DEFAULT_MAX_CONCURRENT_WORKERS = 4;
const defaultLaneOptions = {
	critical: { weight: 6 },
	standard: { weight: 3 },
	background: {
		staleAfterMs: 2e4,
		weight: 1
	}
};
function coerceResponseBody(raw) {
	if (!raw) return;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
function escapeMultipartQuotedValue(value) {
	return value.replace(/["\r\n]/g, (ch) => ch === "\"" ? "%22" : ch === "\r" ? "%0D" : "%0A");
}
async function formDataToMultipartBody(body, headers) {
	const boundary = `----openclaw-discord-${randomBytes(12).toString("hex")}`;
	headers.set("Content-Type", `multipart/form-data; boundary=${boundary}`);
	const chunks = [];
	const push = (value) => {
		chunks.push(typeof value === "string" ? Buffer.from(value) : value);
	};
	for (const [key, value] of body.entries()) {
		push(`--${boundary}\r\n`);
		const escapedKey = escapeMultipartQuotedValue(key);
		if (typeof value === "string") {
			push(`Content-Disposition: form-data; name="${escapedKey}"\r\n\r\n`);
			push(value);
			push("\r\n");
			continue;
		}
		const filename = value.name;
		push(`Content-Disposition: form-data; name="${escapedKey}"; filename="${escapeMultipartQuotedValue(typeof filename === "string" && filename.length > 0 ? filename : "blob")}"\r\n`);
		if (value.type) push(`Content-Type: ${value.type}\r\n`);
		push("\r\n");
		push(Buffer.from(await value.arrayBuffer()));
		push("\r\n");
	}
	push(`--${boundary}--\r\n`);
	return Buffer.concat(chunks);
}
async function normalizeFetchBody(body, headers) {
	if (body instanceof FormData) return await formDataToMultipartBody(body, headers);
	return body;
}
var RequestClient = class {
	constructor(token, options) {
		this.requestControllers = /* @__PURE__ */ new Set();
		this.token = token.replace(/^Bot\s+/i, "");
		this.customFetch = options?.fetch;
		this.options = {
			...defaultOptions,
			...options
		};
		this.scheduler = new RestScheduler({
			lanes: normalizeSchedulerLanes(this.options.maxQueueSize ?? defaultOptions.maxQueueSize, this.options.scheduler?.lanes),
			maxConcurrency: this.options.scheduler?.maxConcurrency ?? DEFAULT_MAX_CONCURRENT_WORKERS,
			maxQueueSize: this.options.maxQueueSize ?? defaultOptions.maxQueueSize,
			maxRateLimitRetries: this.options.scheduler?.maxRateLimitRetries ?? 3
		}, async (request) => await this.executeRequest(request.method, request.path, {
			data: request.data,
			query: request.query
		}, request.routeKey));
	}
	async get(path, query) {
		return await this.request("GET", path, { query });
	}
	async post(path, data, query) {
		return await this.request("POST", path, {
			data,
			query
		});
	}
	async patch(path, data, query) {
		return await this.request("PATCH", path, {
			data,
			query
		});
	}
	async put(path, data, query) {
		return await this.request("PUT", path, {
			data,
			query
		});
	}
	async delete(path, data, query) {
		return await this.request("DELETE", path, {
			data,
			query
		});
	}
	async request(method, path, params) {
		const routeKey = createRouteKey(method, path);
		if (!this.options.queueRequests) return await this.executeRequest(method, path, params, routeKey);
		return await this.scheduler.enqueue({
			method,
			path,
			priority: getRequestPriority(method, path),
			...params
		});
	}
	async executeRequest(method, path, params, routeKey = createRouteKey(method, path)) {
		const url = `${this.options.baseUrl}/v${this.options.apiVersion}${appendQuery(path, params.query)}`;
		const headers = new Headers({ "User-Agent": this.options.userAgent ?? defaultOptions.userAgent });
		if (this.token !== "webhook") headers.set("Authorization", `${this.options.tokenHeader ?? "Bot"} ${this.token}`);
		const body = serializeRequestBody(params.data, headers);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.options.timeout ?? 15e3);
		timeout.unref?.();
		this.requestControllers.add(controller);
		try {
			const response = await (this.customFetch ?? fetch)(url, {
				method,
				headers,
				body: await normalizeFetchBody(body, headers),
				signal: controller.signal
			});
			const parsed = coerceResponseBody(await response.text());
			this.scheduler.recordResponse(routeKey, path, response, parsed);
			if (response.status === 204) return;
			if (response.status === 429) {
				const rateLimitBody = isDiscordRateLimitBody(parsed) ? parsed : void 0;
				throw new RateLimitError(response, {
					message: readDiscordMessage(rateLimitBody, "Rate limited"),
					retry_after: readRetryAfter(rateLimitBody, response, 1),
					code: readDiscordCode(rateLimitBody),
					global: Boolean(rateLimitBody?.global)
				});
			}
			if (!response.ok) throw new DiscordError(response, parsed);
			return parsed;
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") throw error;
			if (error instanceof Error) throw error;
			throw new Error(`Discord request failed: ${inspect(error)}`, { cause: error });
		} finally {
			clearTimeout(timeout);
			this.requestControllers.delete(controller);
		}
	}
	clearQueue() {
		this.scheduler.clearQueue();
	}
	get queueSize() {
		return this.scheduler.queueSize;
	}
	getSchedulerMetrics() {
		return this.scheduler.getMetrics();
	}
	abortAllRequests() {
		this.scheduler.abortPending();
		for (const controller of this.requestControllers) controller.abort();
		this.requestControllers.clear();
	}
};
function normalizeSchedulerLanes(maxQueueSize, lanes) {
	const fallbackMaxQueueSize = Math.max(1, Math.floor(maxQueueSize));
	return {
		critical: normalizeSchedulerLane("critical", fallbackMaxQueueSize, lanes?.critical),
		standard: normalizeSchedulerLane("standard", fallbackMaxQueueSize, lanes?.standard),
		background: normalizeSchedulerLane("background", fallbackMaxQueueSize, lanes?.background)
	};
}
function normalizeSchedulerLane(lane, maxQueueSize, options) {
	const defaults = defaultLaneOptions[lane];
	return {
		maxQueueSize: options?.maxQueueSize !== void 0 ? Math.max(1, Math.floor(options.maxQueueSize)) : maxQueueSize,
		staleAfterMs: options?.staleAfterMs !== void 0 ? Math.max(0, Math.floor(options.staleAfterMs)) : defaults.staleAfterMs,
		weight: options?.weight !== void 0 ? Math.max(1, Math.floor(options.weight)) : defaults.weight
	};
}
function getRequestPriority(method, path) {
	const normalizedMethod = method.toUpperCase();
	const normalizedPath = path.toLowerCase();
	if (/^\/interactions\/\d+\/[^/]+\/callback$/.test(normalizedPath)) return "critical";
	return normalizedMethod === "GET" ? "background" : "standard";
}
//#endregion
//#region extensions/discord/src/internal/client.ts
var Plugin = class {};
var ComponentRegistry = class {
	constructor() {
		this.entries = /* @__PURE__ */ new Map();
		this.oneOffComponents = /* @__PURE__ */ new Map();
		this.wildcardEntries = [];
	}
	register(entry) {
		const key = parseRegistryKey(entry.customId, entry.customIdParser);
		if (key === "*") {
			if (!this.wildcardEntries.includes(entry)) this.wildcardEntries.push(entry);
			return;
		}
		const entries = this.entries.get(key) ?? [];
		if (!entries.includes(entry)) {
			entries.push(entry);
			this.entries.set(key, entries);
		}
	}
	resolve(customId, options) {
		for (const entries of this.entries.values()) {
			const match = entries.find((entry) => {
				if (options?.componentType !== void 0 && entry.type !== options.componentType) return false;
				const parser = entry.customIdParser ?? parseCustomId;
				return parseRegistryKey(entry.customId, parser) === parseRegistryKey(customId, parser);
			});
			if (match) return match;
		}
		return this.wildcardEntries.find((entry) => {
			if (options?.componentType !== void 0 && entry.type !== options.componentType) return false;
			return true;
		});
	}
	waitForMessageComponent(message, timeoutMs) {
		const key = createOneOffComponentKey(message.id, message.channelId);
		return new Promise((resolve) => {
			const existing = this.oneOffComponents.get(key);
			if (existing) {
				clearTimeout(existing.timer);
				existing.resolve({
					success: false,
					message,
					reason: "timed out"
				});
			}
			const timer = setTimeout(() => {
				this.oneOffComponents.delete(key);
				resolve({
					success: false,
					message,
					reason: "timed out"
				});
			}, Math.max(0, timeoutMs));
			timer.unref?.();
			this.oneOffComponents.set(key, {
				message,
				timer,
				resolve
			});
		});
	}
	resolveOneOffComponent(params) {
		if (!params.messageId || !params.channelId) return false;
		const entry = this.oneOffComponents.get(createOneOffComponentKey(params.messageId, params.channelId));
		if (!entry) return false;
		clearTimeout(entry.timer);
		this.oneOffComponents.delete(createOneOffComponentKey(params.messageId, params.channelId));
		entry.resolve({
			success: true,
			customId: params.customId,
			message: entry.message,
			values: params.values
		});
		return true;
	}
};
function parseRegistryKey(customId, parser = parseCustomId) {
	return parser(customId).key;
}
function createOneOffComponentKey(messageId, channelId) {
	return `${messageId}:${channelId}`;
}
var Client = class {
	constructor(options, handlers, plugins = []) {
		this.routes = [];
		this.plugins = [];
		this.componentHandler = new ComponentRegistry();
		this.modalHandler = new ComponentRegistry();
		if (!options.clientId) throw new Error("Missing Discord application ID");
		if (!options.token) throw new Error("Missing Discord bot token");
		this.options = {
			...options,
			baseUrl: options.baseUrl.replace(/\/+$/, "")
		};
		this.commands = handlers.commands ?? [];
		this.listeners = handlers.listeners ?? [];
		this.rest = new RequestClient(options.token, options.requestOptions);
		this.eventQueue = this.options.eventQueue ? new DiscordEventQueue(this.options.eventQueue) : void 0;
		this.entityCache = new DiscordEntityCache({
			client: this,
			rest: () => this.rest,
			ttlMs: this.options.restCacheTtlMs
		});
		this.commandDeployer = new DiscordCommandDeployer({
			clientId: this.options.clientId,
			commands: this.commands,
			devGuilds: this.options.devGuilds,
			hashStorePath: this.options.commandDeployHashStorePath,
			rest: () => this.rest
		});
		for (const component of handlers.components ?? []) this.componentHandler.register(component);
		for (const command of this.commands) for (const component of command.components ?? []) this.componentHandler.register(component);
		for (const modal of handlers.modals ?? []) this.modalHandler.register(modal);
		for (const plugin of plugins) {
			plugin.registerClient?.(this);
			plugin.registerRoutes?.(this);
			this.plugins.push({
				id: plugin.id,
				plugin
			});
		}
	}
	getPlugin(id) {
		return this.plugins.find((entry) => entry.id === id)?.plugin;
	}
	registerListener(listener) {
		if (!this.listeners.includes(listener)) this.listeners.push(listener);
		return listener;
	}
	unregisterListener(listener) {
		const index = this.listeners.indexOf(listener);
		if (index < 0) return false;
		this.listeners.splice(index, 1);
		return true;
	}
	getRuntimeMetrics() {
		return {
			request: this.rest.getSchedulerMetrics(),
			eventQueue: this.eventQueue?.getMetrics()
		};
	}
	async fetchUser(id) {
		return await this.entityCache.fetchUser(id);
	}
	async fetchChannel(id) {
		return await this.entityCache.fetchChannel(id);
	}
	async fetchGuild(id) {
		return await this.entityCache.fetchGuild(id);
	}
	async fetchMember(guildId, userId) {
		return await this.entityCache.fetchMember(guildId, userId);
	}
	async getDiscordCommands() {
		return await this.commandDeployer.getCommands();
	}
	async deployCommands(options = {}) {
		return await this.commandDeployer.deploy(options);
	}
	async reconcileCommands() {
		return await this.deployCommands({ mode: "reconcile" });
	}
	async handleInteraction(rawData, _ctx) {
		await dispatchInteraction(this, rawData);
	}
	async dispatchGatewayEvent(type, data) {
		this.entityCache.invalidateForGatewayEvent(type, data);
		const listeners = this.listeners.filter((entry) => entry.type === type);
		if (!this.eventQueue) {
			for (const listener of listeners) await listener.handle(data, this);
			return;
		}
		await Promise.all(listeners.map((listener) => this.eventQueue.enqueue({
			eventType: type,
			listenerName: listener.constructor.name || "AnonymousListener",
			run: async () => {
				await listener.handle(data, this);
			}
		})));
	}
};
//#endregion
//#region extensions/discord/src/internal/embeds.ts
function clean(value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0));
}
var Embed = class {
	constructor(embed) {
		Object.assign(this, embed);
	}
	serialize() {
		return clean({
			title: this.title,
			description: this.description,
			url: this.url,
			timestamp: this.timestamp,
			color: this.color,
			footer: this.footer,
			image: typeof this.image === "string" ? { url: this.image } : this.image,
			thumbnail: typeof this.thumbnail === "string" ? { url: this.thumbnail } : this.thumbnail,
			author: this.author,
			fields: this.fields
		});
	}
};
//#endregion
//#region extensions/discord/src/internal/listeners.ts
var BaseListener = class {};
var ReadyListener = class extends BaseListener {
	constructor(..._args) {
		super(..._args);
		this.type = GatewayDispatchEvents.Ready;
	}
};
var ResumedListener = class extends BaseListener {
	constructor(..._args2) {
		super(..._args2);
		this.type = GatewayDispatchEvents.Resumed;
	}
};
var MessageCreateListener = class extends BaseListener {
	constructor(..._args3) {
		super(..._args3);
		this.type = GatewayDispatchEvents.MessageCreate;
	}
};
var InteractionCreateListener = class extends BaseListener {
	constructor(..._args4) {
		super(..._args4);
		this.type = GatewayDispatchEvents.InteractionCreate;
	}
};
var MessageReactionAddListener = class extends BaseListener {
	constructor(..._args5) {
		super(..._args5);
		this.type = GatewayDispatchEvents.MessageReactionAdd;
	}
};
var MessageReactionRemoveListener = class extends BaseListener {
	constructor(..._args6) {
		super(..._args6);
		this.type = GatewayDispatchEvents.MessageReactionRemove;
	}
};
var PresenceUpdateListener = class extends BaseListener {
	constructor(..._args7) {
		super(..._args7);
		this.type = GatewayDispatchEvents.PresenceUpdate;
	}
};
var VoiceStateUpdateListener = class extends BaseListener {
	constructor(..._args8) {
		super(..._args8);
		this.type = GatewayDispatchEvents.VoiceStateUpdate;
	}
};
var ThreadUpdateListener = class extends BaseListener {
	constructor(..._args9) {
		super(..._args9);
		this.type = GatewayDispatchEvents.ThreadUpdate;
	}
};
//#endregion
export { createChannelMessage as $, Button as A, putChannelPermission as At, Separator as B, GatewayIntentBits as Bt, User as C, getGuildVoiceState as Ct, Modal as D, listGuildRoles as Dt, Label as E, listGuildEmojis as Et, MediaGallery as F, ButtonStyle as Ft, BaseMessageInteractiveComponent as G, StickerFormatType as Gt, TextDisplay as H, MessageFlags as Ht, MentionableSelectMenu as I, ChannelType as It, createUserDmChannel as J, parseCustomId as K, TextInputStyle as Kt, RoleSelectMenu as L, ComponentType as Lt, Container as M, removeGuildMemberRole as Mt, File as N, timeoutGuildMember as Nt, RadioGroup as O, listGuildScheduledEvents as Ot, LinkButton as P, ApplicationCommandOptionType as Pt, listMessageReactionUsers as Q, Row as R, GatewayCloseCodes as Rt, Message as S, getGuildMember as St, CheckboxGroup as T, listGuildChannels as Tt, Thumbnail as U, MessageType as Ut, StringSelectMenu as V, GatewayOpcodes as Vt, UserSelectMenu as W, PermissionFlagsBits as Wt, createOwnMessageReaction as X, getCurrentUser as Y, deleteOwnMessageReaction as Z, readDiscordMessage as _, createGuildEmoji as _t, PresenceUpdateListener as a, getChannel as at, CommandWithSubcommands as b, deleteChannelPermission as bt, ThreadUpdateListener as c, listChannelMessages as ct, Client as d, searchGuildMessages as dt, createThread as et, Plugin as f, sendChannelTyping as ft, readDiscordCode as g, createGuildChannel as gt, RateLimitError as h, createGuildBan as ht, MessageReactionRemoveListener as i, editChannelMessage as it, ChannelSelectMenu as j, removeGuildMember as jt, TextInput as k, moveGuildChannels as kt, VoiceStateUpdateListener as l, listChannelPins as lt, DiscordError as m, addGuildMemberRole as mt, MessageCreateListener as n, deleteChannelMessage as nt, ReadyListener as o, getChannelMessage as ot, RequestClient as p, unpinChannelMessage as pt, createChannelWebhook as q, require_v10$4 as qt, MessageReactionAddListener as r, editChannel as rt, ResumedListener as s, listChannelArchivedThreads as st, InteractionCreateListener as t, deleteChannel as tt, Embed as u, pinChannelMessage as ut, readRetryAfter as v, createGuildScheduledEvent as vt, serializePayload as w, listGuildActiveThreads as wt, Guild as x, getGuild as xt, Command as y, createGuildSticker as yt, Section as z, GatewayDispatchEvents as zt };
