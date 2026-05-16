import { o as resolveDefaultDiscordAccountId } from "./accounts-CaHGiVB4.js";
import { S as Message, ot as getChannelMessage, t as discord_exports } from "./discord-eZlimVfW.js";
import { i as resolveTimestampMs, n as formatDiscordUserTag, r as resolveDiscordSystemLocation } from "./format-D8TsaXxW.js";
import { _ as resolveGroupDmAllow, a as normalizeDiscordSlug, c as resolveDiscordChannelConfigWithFallback, d as resolveDiscordGuildEntry, f as resolveDiscordMemberAccessState, g as resolveDiscordShouldRequireMention, i as normalizeDiscordDisplaySlug, m as resolveDiscordOwnerAccess, n as isDiscordGroupAllowedByPolicy } from "./allow-list-ek-1hMKN.js";
import { t as resolveDiscordConversationIdentity } from "./conversation-identity-BN9wSmxJ.js";
import { l as isRecentlyUnboundThreadWebhookMessage } from "./thread-bindings.state-Dzu1gCE7.js";
import "./thread-bindings-DLoian4S.js";
import { n as resolveDiscordChannelInfoSafe, r as resolveDiscordChannelNameSafe } from "./channel-access-ewDxhd9q.js";
import { c as resolveDiscordChannelInfo, l as resolveDiscordMessageChannelId, r as resolveDiscordMessageText } from "./message-utils-Dmgu-7fC.js";
import { a as shouldIgnoreStaleDiscordRouteBinding, i as resolveDiscordEffectiveRoute, o as handleDiscordDmCommandDecision, r as resolveDiscordConversationRoute, s as resolveDiscordDmCommandAccess, t as buildDiscordRoutePeer } from "./route-resolution-Bx85WEpX.js";
import { n as resolveDiscordWebhookId, t as resolveDiscordSenderIdentity } from "./sender-identity-BiSDAk2P.js";
import { logDebug, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { getChildLogger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { buildMentionRegexes, implicitMentionKindWhen, logInboundDrop, matchesMentionWithExplicit, resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-inbound";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth-native";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import { recordPendingHistoryEntryIfEnabled } from "openclaw/plugin-sdk/reply-history";
//#region extensions/discord/src/monitor/message-handler.dm-preflight.ts
let conversationRuntimePromise$1;
let discordSendRuntimePromise;
async function loadConversationRuntime$1() {
	conversationRuntimePromise$1 ??= import("openclaw/plugin-sdk/conversation-binding-runtime");
	return await conversationRuntimePromise$1;
}
async function loadDiscordSendRuntime() {
	discordSendRuntimePromise ??= import("./send-Dw6Da1m2.js").then((n) => n.t);
	return await discordSendRuntimePromise;
}
async function resolveDiscordDmPreflightAccess(params) {
	if (params.dmPolicy === "disabled") {
		logVerbose("discord: drop dm (dmPolicy: disabled)");
		return null;
	}
	const directBindingConversationId = resolveDiscordConversationIdentity({
		isDirectMessage: true,
		userId: params.author.id
	}) ?? `user:${params.author.id}`;
	const directBindingRecord = (await loadConversationRuntime$1()).getSessionBindingService().resolveByConversation({
		channel: "discord",
		accountId: params.preflight.accountId,
		conversationId: directBindingConversationId
	});
	const dmAccess = await resolveDiscordDmCommandAccess({
		accountId: params.resolvedAccountId,
		dmPolicy: params.dmPolicy,
		configuredAllowFrom: params.preflight.allowFrom ?? [],
		sender: {
			id: params.sender.id,
			name: params.sender.name,
			tag: params.sender.tag
		},
		allowNameMatching: params.allowNameMatching,
		useAccessGroups: params.useAccessGroups,
		cfg: params.preflight.cfg,
		token: params.preflight.token,
		rest: params.preflight.client.rest
	});
	const commandAuthorized = dmAccess.commandAuthorized || directBindingRecord != null;
	if (dmAccess.decision === "allow") return { commandAuthorized };
	if (directBindingRecord) {
		logVerbose(`discord: allow bound DM conversation ${directBindingConversationId} despite dmPolicy=${params.dmPolicy}`);
		return { commandAuthorized };
	}
	const allowMatchMeta = formatAllowlistMatchMeta(dmAccess.allowMatch.allowed ? dmAccess.allowMatch : void 0);
	await handleDiscordDmCommandDecision({
		dmAccess,
		accountId: params.resolvedAccountId,
		sender: {
			id: params.author.id,
			tag: formatDiscordUserTag(params.author),
			name: params.author.username ?? void 0
		},
		onPairingCreated: async (code) => {
			logVerbose(`discord pairing request sender=${params.author.id} tag=${formatDiscordUserTag(params.author)} (${allowMatchMeta})`);
			try {
				const conversationRuntime = await loadConversationRuntime$1();
				const { sendMessageDiscord } = await loadDiscordSendRuntime();
				await sendMessageDiscord(`user:${params.author.id}`, conversationRuntime.buildPairingReply({
					channel: "discord",
					idLine: `Your Discord user id: ${params.author.id}`,
					code
				}), {
					cfg: params.preflight.cfg,
					token: params.preflight.token,
					rest: params.preflight.client.rest,
					accountId: params.preflight.accountId
				});
			} catch (err) {
				logVerbose(`discord pairing reply failed for ${params.author.id}: ${String(err)}`);
			}
		},
		onUnauthorized: async () => {
			logVerbose(`Blocked unauthorized discord sender ${params.sender.id} (dmPolicy=${params.dmPolicy}, ${allowMatchMeta})`);
		}
	});
	return null;
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.hydration.ts
function mergeFetchedDiscordMessage(base, fetched) {
	const baseRawData = readMessageRawData(base);
	const baseFallback = readMessageFallback(base);
	const rawData = {
		...baseRawData,
		...fetched,
		id: fetched.id ?? baseRawData.id ?? baseFallback.id,
		channel_id: fetched.channel_id ?? baseRawData.channel_id ?? baseFallback.channel_id,
		content: fetched.content ?? baseRawData.content ?? baseFallback.content,
		author: fetched.author ?? baseRawData.author ?? baseFallback.author,
		attachments: fetched.attachments ?? baseRawData.attachments ?? baseFallback.attachments,
		embeds: fetched.embeds ?? baseRawData.embeds ?? baseFallback.embeds,
		mentions: fetched.mentions ?? baseRawData.mentions ?? baseFallback.mentions,
		mention_roles: fetched.mention_roles ?? baseRawData.mention_roles ?? baseFallback.mention_roles,
		mention_everyone: fetched.mention_everyone ?? baseRawData.mention_everyone ?? baseFallback.mention_everyone,
		timestamp: fetched.timestamp ?? baseRawData.timestamp ?? baseFallback.timestamp,
		tts: fetched.tts ?? baseRawData.tts ?? false,
		pinned: fetched.pinned ?? baseRawData.pinned ?? false,
		type: fetched.type ?? baseRawData.type ?? 0,
		message_snapshots: fetched.message_snapshots ?? baseRawData.message_snapshots ?? baseFallback.message_snapshots,
		sticker_items: fetched.sticker_items ?? baseRawData.sticker_items ?? baseFallback.sticker_items
	};
	const hydrated = new Message(readMessageClient(base), rawData);
	copyRuntimeMessageFields(base, hydrated);
	return hydrated;
}
function readMessageClient(message) {
	return message.client;
}
function readMessageRawData(message) {
	try {
		const rawData = message.rawData;
		return rawData && typeof rawData === "object" ? rawData : {};
	} catch {
		return {};
	}
}
function readMessageFallback(message) {
	const value = message;
	return {
		id: typeof value.id === "string" ? value.id : "",
		channel_id: readString(value.channel_id) ?? readString(value.channelId) ?? "",
		content: typeof value.content === "string" ? value.content : "",
		author: normalizeApiUser(value.author),
		attachments: Array.isArray(value.attachments) ? value.attachments : [],
		embeds: Array.isArray(value.embeds) ? value.embeds : [],
		mentions: normalizeApiUsers(value.mentionedUsers),
		mention_roles: normalizeStringArray(value.mentionedRoles),
		mention_everyone: value.mentionedEveryone === true,
		timestamp: readString(value.timestamp) ?? "1970-01-01T00:00:00.000Z",
		sticker_items: Array.isArray(value.sticker_items) ? value.sticker_items : Array.isArray(value.stickers) ? value.stickers : void 0,
		message_snapshots: Array.isArray(value.message_snapshots) ? value.message_snapshots : void 0
	};
}
function readString(value) {
	return typeof value === "string" ? value : void 0;
}
function normalizeStringArray(value) {
	return Array.isArray(value) ? value.flatMap((entry) => typeof entry === "string" ? [entry] : []) : [];
}
function normalizeApiUsers(value) {
	return Array.isArray(value) ? value.flatMap((entry) => {
		const user = normalizeApiUser(entry);
		return user.id ? [user] : [];
	}) : [];
}
function normalizeApiUser(value) {
	if (!value || typeof value !== "object") return {
		id: "",
		username: "",
		discriminator: "0",
		global_name: null,
		avatar: null
	};
	const input = value;
	return {
		id: readString(input.id) ?? "",
		username: readString(input.username) ?? "",
		discriminator: readString(input.discriminator) ?? "0",
		global_name: readString(input.global_name) ?? readString(input.globalName) ?? null,
		avatar: input.avatar === null ? null : readString(input.avatar) ?? null,
		...typeof input.bot === "boolean" ? { bot: input.bot } : {}
	};
}
function copyRuntimeMessageFields(source, target) {
	const channelDescriptor = Object.getOwnPropertyDescriptor(source, "channel");
	if (channelDescriptor) Object.defineProperty(target, "channel", channelDescriptor);
}
function shouldHydrateDiscordMessage(params) {
	let currentText = "";
	try {
		currentText = resolveDiscordMessageText(params.message, { includeForwarded: true });
	} catch {
		return true;
	}
	if (!currentText) return true;
	if ((params.message.mentionedUsers?.length ?? 0) > 0 || (params.message.mentionedRoles?.length ?? 0) > 0 || params.message.mentionedEveryone) return false;
	return /<@!?\d+>|<@&\d+>|@everyone|@here/u.test(currentText);
}
async function hydrateDiscordMessageIfNeeded(params) {
	params.channelInfo;
	if (!shouldHydrateDiscordMessage({ message: params.message })) return params.message;
	try {
		const fetched = await getChannelMessage(params.client.rest, params.messageChannelId, params.message.id);
		if (!fetched) return params.message;
		logVerbose(`discord: hydrated inbound payload via REST for ${params.message.id}`);
		return mergeFetchedDiscordMessage(params.message, fetched);
	} catch (err) {
		logVerbose(`discord: failed to hydrate message ${params.message.id}: ${String(err)}`);
		return params.message;
	}
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight-channel-access.ts
function resolveDiscordPreflightChannelAccess(params) {
	if (params.isGuildMessage && params.channelConfig?.enabled === false) {
		logDebug(`[discord-preflight] drop: channel disabled`);
		logVerbose(`Blocked discord channel ${params.messageChannelId} (channel disabled, ${params.channelMatchMeta})`);
		return {
			allowed: false,
			channelAllowlistConfigured: false,
			channelAllowed: false
		};
	}
	const groupDmAllowed = params.isGroupDm && resolveGroupDmAllow({
		channels: params.groupDmChannels,
		channelId: params.messageChannelId,
		channelName: params.displayChannelName,
		channelSlug: params.displayChannelSlug
	});
	if (params.isGroupDm && !groupDmAllowed) return {
		allowed: false,
		channelAllowlistConfigured: false,
		channelAllowed: false
	};
	const channelAllowlistConfigured = Boolean(params.guildInfo?.channels) && Object.keys(params.guildInfo?.channels ?? {}).length > 0;
	const channelAllowed = params.channelConfig?.allowed !== false;
	if (params.isGuildMessage && !isDiscordGroupAllowedByPolicy({
		groupPolicy: params.groupPolicy,
		guildAllowlisted: Boolean(params.guildInfo),
		channelAllowlistConfigured,
		channelAllowed
	})) {
		if (params.groupPolicy === "disabled") {
			logDebug(`[discord-preflight] drop: groupPolicy disabled`);
			logVerbose(`discord: drop guild message (groupPolicy: disabled, ${params.channelMatchMeta})`);
		} else if (!channelAllowlistConfigured) {
			logDebug(`[discord-preflight] drop: groupPolicy allowlist, no channel allowlist configured`);
			logVerbose(`discord: drop guild message (groupPolicy: allowlist, no channel allowlist, ${params.channelMatchMeta})`);
		} else {
			logDebug(`[discord] Ignored message from channel ${params.messageChannelId} (not in guild allowlist). Add to guilds.<guildId>.channels to enable.`);
			logVerbose(`Blocked discord channel ${params.messageChannelId} not in guild channel allowlist (groupPolicy: allowlist, ${params.channelMatchMeta})`);
		}
		return {
			allowed: false,
			channelAllowlistConfigured,
			channelAllowed
		};
	}
	if (params.isGuildMessage && params.channelConfig?.allowed === false) {
		logDebug(`[discord-preflight] drop: channelConfig.allowed===false`);
		logVerbose(`Blocked discord channel ${params.messageChannelId} not in guild channel allowlist (${params.channelMatchMeta})`);
		return {
			allowed: false,
			channelAllowlistConfigured,
			channelAllowed
		};
	}
	if (params.isGuildMessage) {
		logDebug(`[discord-preflight] pass: channel allowed`);
		logVerbose(`discord: allow channel ${params.messageChannelId} (${params.channelMatchMeta})`);
	}
	return {
		allowed: true,
		channelAllowlistConfigured,
		channelAllowed
	};
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight-channel-context.ts
function resolveDiscordPreflightChannelContext(params) {
	const threadName = params.threadChannel?.name;
	const configChannelName = params.threadParentName ?? params.channelName;
	const configChannelSlug = configChannelName ? normalizeDiscordSlug(configChannelName) : "";
	const displayChannelName = threadName ?? params.channelName;
	const displayChannelSlug = displayChannelName ? normalizeDiscordDisplaySlug(displayChannelName) : "";
	const guildSlug = params.guildInfo?.slug || (params.guildName ? normalizeDiscordSlug(params.guildName) : "");
	const threadChannelSlug = params.channelName ? normalizeDiscordSlug(params.channelName) : "";
	const threadParentSlug = params.threadParentName ? normalizeDiscordSlug(params.threadParentName) : "";
	return {
		threadName,
		configChannelName,
		configChannelSlug,
		displayChannelName,
		displayChannelSlug,
		guildSlug,
		threadChannelSlug,
		threadParentSlug,
		channelConfig: params.isGuildMessage ? resolveDiscordChannelConfigWithFallback({
			guildInfo: params.guildInfo,
			channelId: params.messageChannelId,
			channelName: params.channelName,
			channelSlug: threadChannelSlug,
			parentId: params.threadParentId,
			parentName: params.threadParentName,
			parentSlug: threadParentSlug,
			scope: params.threadChannel ? "thread" : "channel"
		}) : null
	};
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight-context.ts
function buildDiscordMessagePreflightContext({ preflightParams, ...fields }) {
	return {
		cfg: preflightParams.cfg,
		discordConfig: preflightParams.discordConfig,
		accountId: preflightParams.accountId,
		token: preflightParams.token,
		runtime: preflightParams.runtime,
		botUserId: preflightParams.botUserId,
		abortSignal: preflightParams.abortSignal,
		guildHistories: preflightParams.guildHistories,
		historyLimit: preflightParams.historyLimit,
		mediaMaxBytes: preflightParams.mediaMaxBytes,
		textLimit: preflightParams.textLimit,
		replyToMode: preflightParams.replyToMode,
		ackReactionScope: preflightParams.ackReactionScope,
		groupPolicy: preflightParams.groupPolicy,
		...fields,
		threadBindings: preflightParams.threadBindings,
		discordRestFetch: preflightParams.discordRestFetch
	};
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight-helpers.ts
const DISCORD_BOUND_THREAD_SYSTEM_PREFIXES = [
	"⚙️",
	"🤖",
	"🧰"
];
function isBoundThreadBotSystemMessage(params) {
	if (!params.isBoundThreadSession || !params.isBotAuthor) return false;
	const text = params.text?.trim();
	if (!text) return false;
	return DISCORD_BOUND_THREAD_SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix));
}
function isDiscordThreadChannelType(type) {
	return type === discord_exports.ChannelType.PublicThread || type === discord_exports.ChannelType.PrivateThread || type === discord_exports.ChannelType.AnnouncementThread;
}
function isDiscordThreadChannelMessage(params) {
	if (!params.isGuildMessage) return false;
	const channel = "channel" in params.message ? params.message.channel : void 0;
	return Boolean(channel && typeof channel === "object" && "isThread" in channel && typeof channel.isThread === "function" && channel.isThread() || isDiscordThreadChannelType(params.channelInfo?.type));
}
function resolveInjectedBoundThreadLookupRecord(params) {
	const getByThreadId = params.threadBindings.getByThreadId;
	if (typeof getByThreadId !== "function") return;
	const binding = getByThreadId(params.threadId);
	return binding && typeof binding === "object" ? binding : void 0;
}
function resolveDiscordMentionState(params) {
	if (params.isDirectMessage) return {
		implicitMentionKinds: [],
		wasMentioned: false
	};
	const wasMentioned = params.mentionedEveryone && (!params.authorIsBot || params.senderIsPluralKit) || matchesMentionWithExplicit({
		text: params.mentionText,
		mentionRegexes: params.mentionRegexes,
		explicit: {
			hasAnyMention: params.hasAnyMention,
			isExplicitlyMentioned: params.isExplicitlyMentioned,
			canResolveExplicit: Boolean(params.botId)
		},
		transcript: params.transcript
	});
	return {
		implicitMentionKinds: implicitMentionKindWhen("reply_to_bot", Boolean(params.botId) && Boolean(params.referencedAuthorId) && params.referencedAuthorId === params.botId),
		wasMentioned
	};
}
function resolvePreflightMentionRequirement(params) {
	if (!params.shouldRequireMention) return false;
	return !params.bypassMentionRequirement;
}
function shouldIgnoreBoundThreadWebhookMessage(params) {
	const webhookId = normalizeOptionalString(params.webhookId) ?? "";
	if (!webhookId) return false;
	const boundWebhookId = normalizeOptionalString(params.threadBinding?.webhookId) ?? normalizeOptionalString(params.threadBinding?.metadata?.webhookId) ?? "";
	if (boundWebhookId && webhookId === boundWebhookId) return true;
	const threadId = normalizeOptionalString(params.threadId) ?? "";
	if (!threadId) return false;
	if (params.threadBinding) return true;
	return isRecentlyUnboundThreadWebhookMessage({
		accountId: params.accountId,
		threadId,
		webhookId
	});
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight-history.ts
function buildDiscordPreflightHistoryEntry(params) {
	const textForHistory = resolveDiscordMessageText(params.message, { includeForwarded: true });
	return params.isGuildMessage && params.historyLimit > 0 && textForHistory ? {
		sender: params.senderLabel,
		body: textForHistory,
		timestamp: resolveTimestampMs(params.message.timestamp),
		messageId: params.message.id
	} : void 0;
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight-logging.ts
function logDiscordPreflightChannelConfig(params) {
	if (!shouldLogVerbose()) return;
	logDebug(`[discord-preflight] channelConfig=${params.channelConfig ? `allowed=${params.channelConfig.allowed} enabled=${params.channelConfig.enabled ?? "unset"} requireMention=${params.channelConfig.requireMention ?? "unset"} ignoreOtherMentions=${params.channelConfig.ignoreOtherMentions ?? "unset"} matchKey=${params.channelConfig.matchKey ?? "none"} matchSource=${params.channelConfig.matchSource ?? "none"} users=${params.channelConfig.users?.length ?? 0} roles=${params.channelConfig.roles?.length ?? 0} skills=${params.channelConfig.skills?.length ?? 0}` : "none"} channelMatchMeta=${params.channelMatchMeta} channelId=${params.channelId}`);
}
function logDiscordPreflightInboundSummary(params) {
	if (!shouldLogVerbose()) return;
	logVerbose(`discord: inbound id=${params.messageId} guild=${params.guildId ?? "dm"} channel=${params.channelId} mention=${params.wasMentioned ? "yes" : "no"} type=${params.isDirectMessage ? "dm" : params.isGroupDm ? "group-dm" : "guild"} content=${params.hasContent ? "yes" : "no"}`);
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight-runtime.ts
let pluralkitRuntimePromise;
let preflightAudioRuntimePromise;
let systemEventsRuntimePromise;
let discordThreadingRuntimePromise;
async function loadPluralKitRuntime() {
	pluralkitRuntimePromise ??= import("./pluralkit-voQvSN3g.js").then((n) => n.n);
	return await pluralkitRuntimePromise;
}
async function loadPreflightAudioRuntime() {
	preflightAudioRuntimePromise ??= import("./preflight-audio-BpYtUAT6.js");
	return await preflightAudioRuntimePromise;
}
async function loadSystemEventsRuntime() {
	systemEventsRuntimePromise ??= import("./system-events-B-xNU7II.js");
	return await systemEventsRuntimePromise;
}
async function loadDiscordThreadingRuntime() {
	discordThreadingRuntimePromise ??= import("./threading-Bi95Nz8h.js").then((n) => n.t);
	return await discordThreadingRuntimePromise;
}
function isPreflightAborted(abortSignal) {
	return Boolean(abortSignal?.aborted);
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight-pluralkit.ts
async function resolveDiscordPreflightPluralKitInfo(params) {
	if (!params.config?.enabled) return null;
	try {
		const { fetchPluralKitMessageInfo } = await loadPluralKitRuntime();
		const info = await fetchPluralKitMessageInfo({
			messageId: params.message.id,
			config: params.config
		});
		return isPreflightAborted(params.abortSignal) ? null : info;
	} catch (err) {
		logVerbose(`discord: pluralkit lookup failed for ${params.message.id}: ${String(err)}`);
		return null;
	}
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight-thread.ts
async function resolveDiscordPreflightThreadContext(params) {
	const { resolveDiscordThreadChannel, resolveDiscordThreadParentInfo } = await loadDiscordThreadingRuntime();
	const earlyThreadChannel = resolveDiscordThreadChannel({
		isGuildMessage: params.isGuildMessage,
		message: params.message,
		channelInfo: params.channelInfo,
		messageChannelId: params.messageChannelId
	});
	if (!earlyThreadChannel) return { earlyThreadChannel: null };
	const parentInfo = await resolveDiscordThreadParentInfo({
		client: params.client,
		threadChannel: earlyThreadChannel,
		channelInfo: params.channelInfo
	});
	if (isPreflightAborted(params.abortSignal)) return null;
	return {
		earlyThreadChannel,
		earlyThreadParentId: parentInfo.id,
		earlyThreadParentName: parentInfo.name,
		earlyThreadParentType: parentInfo.type
	};
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.routing-preflight.ts
let conversationRuntimePromise;
async function loadConversationRuntime() {
	conversationRuntimePromise ??= import("openclaw/plugin-sdk/conversation-binding-runtime");
	return await conversationRuntimePromise;
}
async function resolveDiscordPreflightRoute(params) {
	const conversationRuntime = await loadConversationRuntime();
	const route = resolveDiscordConversationRoute({
		cfg: params.preflight.cfg,
		accountId: params.preflight.accountId,
		guildId: params.preflight.data.guild_id ?? void 0,
		memberRoleIds: params.memberRoleIds,
		peer: buildDiscordRoutePeer({
			isDirectMessage: params.isDirectMessage,
			isGroupDm: params.isGroupDm,
			directUserId: params.author.id,
			conversationId: params.messageChannelId
		}),
		parentConversationId: params.earlyThreadParentId
	});
	const bindingConversationId = params.isDirectMessage ? resolveDiscordConversationIdentity({
		isDirectMessage: true,
		userId: params.author.id
	}) ?? `user:${params.author.id}` : params.messageChannelId;
	let runtimeRoute = conversationRuntime.resolveRuntimeConversationBindingRoute({
		route,
		conversation: {
			channel: "discord",
			accountId: params.preflight.accountId,
			conversationId: bindingConversationId,
			parentConversationId: params.earlyThreadParentId
		}
	});
	if (shouldIgnoreStaleDiscordRouteBinding({
		bindingRecord: runtimeRoute.bindingRecord,
		route
	})) {
		logVerbose(`discord: ignoring stale route binding for conversation ${bindingConversationId} (${runtimeRoute.bindingRecord?.targetSessionKey} -> ${route.sessionKey})`);
		runtimeRoute = {
			bindingRecord: null,
			route
		};
	}
	let threadBinding = runtimeRoute.bindingRecord ?? void 0;
	const configuredRoute = threadBinding == null ? conversationRuntime.resolveConfiguredBindingRoute({
		cfg: params.preflight.cfg,
		route,
		conversation: {
			channel: "discord",
			accountId: params.preflight.accountId,
			conversationId: params.messageChannelId,
			parentConversationId: params.earlyThreadParentId
		}
	}) : null;
	const configuredBinding = configuredRoute?.bindingResolution ?? null;
	if (!threadBinding && configuredBinding) threadBinding = configuredBinding.record;
	const boundSessionKey = conversationRuntime.isPluginOwnedSessionBindingRecord(threadBinding) ? "" : runtimeRoute.boundSessionKey ?? threadBinding?.targetSessionKey?.trim();
	const effectiveRoute = runtimeRoute.boundSessionKey ? runtimeRoute.route : resolveDiscordEffectiveRoute({
		route,
		boundSessionKey,
		configuredRoute,
		matchedBy: "binding.channel"
	});
	return {
		conversationRuntime,
		threadBinding,
		configuredBinding,
		boundSessionKey,
		effectiveRoute,
		boundAgentId: boundSessionKey ? effectiveRoute.agentId : void 0,
		baseSessionKey: effectiveRoute.sessionKey
	};
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight.ts
function resolveDiscordPreflightConversationKind(params) {
	const isGroupDm = params.channelType === discord_exports.ChannelType.GroupDM;
	return {
		isDirectMessage: params.channelType === discord_exports.ChannelType.DM || !params.isGuildMessage && !isGroupDm && params.channelType == null,
		isGroupDm
	};
}
async function preflightDiscordMessage(params) {
	if (isPreflightAborted(params.abortSignal)) return null;
	const logger = getChildLogger({ module: "discord-auto-reply" });
	let message = params.data.message;
	const author = params.data.author;
	if (!author) return null;
	const messageChannelId = resolveDiscordMessageChannelId({
		message,
		eventChannelId: params.data.channel_id
	});
	if (!messageChannelId) {
		logVerbose(`discord: drop message ${message.id} (missing channel id)`);
		return null;
	}
	const allowBotsSetting = params.discordConfig?.allowBots;
	const allowBotsMode = allowBotsSetting === "mentions" ? "mentions" : allowBotsSetting === true ? "all" : "off";
	if (params.botUserId && author.id === params.botUserId) return null;
	message = await hydrateDiscordMessageIfNeeded({
		client: params.client,
		message,
		messageChannelId
	});
	if (isPreflightAborted(params.abortSignal)) return null;
	const pluralkitConfig = params.discordConfig?.pluralkit;
	const webhookId = resolveDiscordWebhookId(message);
	const isGuildMessage = Boolean(params.data.guild_id);
	const channelInfo = await resolveDiscordChannelInfo(params.client, messageChannelId);
	if (isPreflightAborted(params.abortSignal)) return null;
	const { isDirectMessage, isGroupDm } = resolveDiscordPreflightConversationKind({
		isGuildMessage,
		channelType: channelInfo?.type
	});
	const messageText = resolveDiscordMessageText(message, { includeForwarded: true });
	const injectedBoundThreadBinding = !isDirectMessage && !isGroupDm ? resolveInjectedBoundThreadLookupRecord({
		threadBindings: params.threadBindings,
		threadId: messageChannelId
	}) : void 0;
	if (shouldIgnoreBoundThreadWebhookMessage({
		accountId: params.accountId,
		threadId: messageChannelId,
		webhookId,
		threadBinding: injectedBoundThreadBinding
	})) {
		logVerbose(`discord: drop bound-thread webhook echo message ${message.id}`);
		return null;
	}
	if (isBoundThreadBotSystemMessage({
		isBoundThreadSession: Boolean(injectedBoundThreadBinding) && isDiscordThreadChannelMessage({
			isGuildMessage,
			message,
			channelInfo
		}),
		isBotAuthor: Boolean(author.bot),
		text: messageText
	})) {
		logVerbose(`discord: drop bound-thread bot system message ${message.id}`);
		return null;
	}
	const pluralkitInfo = await resolveDiscordPreflightPluralKitInfo({
		message,
		config: pluralkitConfig,
		abortSignal: params.abortSignal
	});
	if (isPreflightAborted(params.abortSignal)) return null;
	const sender = resolveDiscordSenderIdentity({
		author,
		member: params.data.member,
		pluralkitInfo
	});
	if (author.bot) {
		if (allowBotsMode === "off" && !sender.isPluralKit) {
			logVerbose("discord: drop bot message (allowBots=false)");
			return null;
		}
	}
	const data = message === params.data.message ? params.data : {
		...params.data,
		message
	};
	logDebug(`[discord-preflight] channelId=${messageChannelId} guild_id=${params.data.guild_id} channelType=${channelInfo?.type} isGuild=${isGuildMessage} isDM=${isDirectMessage} isGroupDm=${isGroupDm}`);
	if (isGroupDm && !params.groupDmEnabled) {
		logVerbose("discord: drop group dm (group dms disabled)");
		return null;
	}
	if (isDirectMessage && !params.dmEnabled) {
		logVerbose("discord: drop dm (dms disabled)");
		return null;
	}
	const dmPolicy = params.dmPolicy;
	const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
	const resolvedAccountId = params.accountId ?? resolveDefaultDiscordAccountId(params.cfg);
	const allowNameMatching = isDangerousNameMatchingEnabled(params.discordConfig);
	let commandAuthorized = true;
	if (isDirectMessage) {
		const access = await resolveDiscordDmPreflightAccess({
			preflight: params,
			author,
			sender,
			dmPolicy,
			resolvedAccountId,
			allowNameMatching,
			useAccessGroups
		});
		if (isPreflightAborted(params.abortSignal)) return null;
		if (!access) return null;
		commandAuthorized = access.commandAuthorized;
	}
	const botId = params.botUserId;
	const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
	if (!isDirectMessage && baseText && hasControlCommand(baseText, params.cfg)) {
		logVerbose(`discord: drop text-based slash command ${message.id} (intercepted at gateway)`);
		return null;
	}
	recordChannelActivity({
		channel: "discord",
		accountId: params.accountId,
		direction: "inbound"
	});
	const channelName = channelInfo?.name ?? (isGuildMessage || isGroupDm ? resolveDiscordChannelNameSafe("channel" in message ? message.channel : void 0) : void 0);
	const threadContext = await resolveDiscordPreflightThreadContext({
		client: params.client,
		isGuildMessage,
		message,
		channelInfo,
		messageChannelId,
		abortSignal: params.abortSignal
	});
	if (!threadContext) return null;
	const { earlyThreadChannel, earlyThreadParentId, earlyThreadParentName, earlyThreadParentType } = threadContext;
	const memberRoleIds = Array.isArray(params.data.rawMember?.roles) ? params.data.rawMember.roles : [];
	const { conversationRuntime, threadBinding, configuredBinding, boundSessionKey, effectiveRoute, boundAgentId, baseSessionKey } = await resolveDiscordPreflightRoute({
		preflight: params,
		author,
		isDirectMessage,
		isGroupDm,
		messageChannelId,
		memberRoleIds,
		earlyThreadParentId
	});
	if (shouldIgnoreBoundThreadWebhookMessage({
		accountId: params.accountId,
		threadId: messageChannelId,
		webhookId,
		threadBinding
	})) {
		logVerbose(`discord: drop bound-thread webhook echo message ${message.id}`);
		return null;
	}
	const isBoundThreadSession = Boolean(threadBinding && earlyThreadChannel);
	const bypassMentionRequirement = isBoundThreadSession;
	if (isBoundThreadBotSystemMessage({
		isBoundThreadSession,
		isBotAuthor: Boolean(author.bot),
		text: messageText
	})) {
		logVerbose(`discord: drop bound-thread bot system message ${message.id}`);
		return null;
	}
	const mentionRegexes = buildMentionRegexes(params.cfg, effectiveRoute.agentId);
	const explicitlyMentioned = Boolean(botId && message.mentionedUsers?.some((user) => user.id === botId));
	const hasAnyMention = !isDirectMessage && ((message.mentionedUsers?.length ?? 0) > 0 || (message.mentionedRoles?.length ?? 0) > 0 || message.mentionedEveryone && (!author.bot || sender.isPluralKit));
	const hasUserOrRoleMention = !isDirectMessage && ((message.mentionedUsers?.length ?? 0) > 0 || (message.mentionedRoles?.length ?? 0) > 0);
	if (isGuildMessage && (message.type === discord_exports.MessageType.ChatInputCommand || message.type === discord_exports.MessageType.ContextMenuCommand)) {
		logVerbose("discord: drop channel command message");
		return null;
	}
	const guildInfo = isGuildMessage ? resolveDiscordGuildEntry({
		guild: params.data.guild ?? void 0,
		guildId: params.data.guild_id ?? void 0,
		guildEntries: params.guildEntries
	}) : null;
	logDebug(`[discord-preflight] guild_id=${params.data.guild_id} guild_obj=${!!params.data.guild} guild_obj_id=${params.data.guild?.id} guildInfo=${!!guildInfo} guildEntries=${params.guildEntries ? Object.keys(params.guildEntries).join(",") : "none"}`);
	if (isGuildMessage && params.guildEntries && Object.keys(params.guildEntries).length > 0 && !guildInfo) {
		logDebug(`[discord-preflight] guild blocked: guild_id=${params.data.guild_id} guildEntries keys=${Object.keys(params.guildEntries).join(",")}`);
		logVerbose(`Blocked discord guild ${params.data.guild_id ?? "unknown"} (not in discord.guilds)`);
		return null;
	}
	const threadChannel = earlyThreadChannel;
	const threadParentId = earlyThreadParentId;
	const threadParentName = earlyThreadParentName;
	const threadParentType = earlyThreadParentType;
	const { threadName, configChannelName, configChannelSlug, displayChannelName, displayChannelSlug, guildSlug, channelConfig } = resolveDiscordPreflightChannelContext({
		isGuildMessage,
		messageChannelId,
		channelName,
		guildName: params.data.guild?.name,
		guildInfo,
		threadChannel,
		threadParentId,
		threadParentName
	});
	const channelMatchMeta = formatAllowlistMatchMeta(channelConfig);
	logDiscordPreflightChannelConfig({
		channelConfig,
		channelMatchMeta,
		channelId: messageChannelId
	});
	const channelAccess = resolveDiscordPreflightChannelAccess({
		isGuildMessage,
		isGroupDm,
		groupPolicy: params.groupPolicy,
		groupDmChannels: params.groupDmChannels,
		messageChannelId,
		displayChannelName,
		displayChannelSlug,
		guildInfo,
		channelConfig,
		channelMatchMeta
	});
	if (!channelAccess.allowed) return null;
	const { channelAllowlistConfigured, channelAllowed } = channelAccess;
	const historyEntry = buildDiscordPreflightHistoryEntry({
		isGuildMessage,
		historyLimit: params.historyLimit,
		message,
		senderLabel: sender.label
	});
	const threadOwnerId = threadChannel ? resolveDiscordChannelInfoSafe(threadChannel).ownerId ?? channelInfo?.ownerId : void 0;
	const shouldRequireMentionByConfig = resolveDiscordShouldRequireMention({
		isGuildMessage,
		isThread: Boolean(threadChannel),
		botId,
		threadOwnerId,
		channelConfig,
		guildInfo
	});
	const shouldRequireMention = resolvePreflightMentionRequirement({
		shouldRequireMention: shouldRequireMentionByConfig,
		bypassMentionRequirement
	});
	const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
		channelConfig,
		guildInfo,
		memberRoleIds,
		sender,
		allowNameMatching
	});
	if (isGuildMessage && hasAccessRestrictions && !memberAllowed) {
		logDebug(`[discord-preflight] drop: member not allowed`);
		logVerbose("Blocked discord guild sender (not in users/roles allowlist)");
		return null;
	}
	const { resolveDiscordPreflightAudioMentionContext } = await loadPreflightAudioRuntime();
	const { hasTypedText, transcript: preflightTranscript } = await resolveDiscordPreflightAudioMentionContext({
		message,
		isDirectMessage,
		shouldRequireMention,
		mentionRegexes,
		cfg: params.cfg,
		abortSignal: params.abortSignal
	});
	if (isPreflightAborted(params.abortSignal)) return null;
	const mentionText = hasTypedText ? baseText : "";
	const { implicitMentionKinds, wasMentioned } = resolveDiscordMentionState({
		authorIsBot: Boolean(author.bot),
		botId,
		hasAnyMention,
		isDirectMessage,
		isExplicitlyMentioned: explicitlyMentioned,
		mentionRegexes,
		mentionText,
		mentionedEveryone: message.mentionedEveryone,
		referencedAuthorId: message.referencedMessage?.author?.id,
		senderIsPluralKit: sender.isPluralKit,
		transcript: preflightTranscript
	});
	logDiscordPreflightInboundSummary({
		messageId: message.id,
		guildId: params.data.guild_id ?? void 0,
		channelId: messageChannelId,
		wasMentioned,
		isDirectMessage,
		isGroupDm,
		hasContent: Boolean(messageText)
	});
	const allowTextCommands = shouldHandleTextCommands({
		cfg: params.cfg,
		surface: "discord"
	});
	const hasControlCommandInMessage = hasControlCommand(baseText, params.cfg);
	if (!isDirectMessage) {
		const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
			allowFrom: params.allowFrom,
			sender: {
				id: sender.id,
				name: sender.name,
				tag: sender.tag
			},
			allowNameMatching
		});
		const commandGate = resolveControlCommandGate({
			useAccessGroups,
			authorizers: [{
				configured: ownerAllowList != null,
				allowed: ownerOk
			}, {
				configured: hasAccessRestrictions,
				allowed: memberAllowed
			}],
			modeWhenAccessGroupsOff: "configured",
			allowTextCommands,
			hasControlCommand: hasControlCommandInMessage
		});
		commandAuthorized = commandGate.commandAuthorized;
		if (commandGate.shouldBlock) {
			logInboundDrop({
				log: logVerbose,
				channel: "discord",
				reason: "control command (unauthorized)",
				target: sender.id
			});
			return null;
		}
	}
	const canDetectMention = Boolean(botId) || mentionRegexes.length > 0;
	const mentionDecision = resolveInboundMentionDecision({
		facts: {
			canDetectMention,
			wasMentioned,
			hasAnyMention,
			implicitMentionKinds
		},
		policy: {
			isGroup: isGuildMessage,
			requireMention: shouldRequireMention,
			allowTextCommands,
			hasControlCommand: hasControlCommandInMessage,
			commandAuthorized
		}
	});
	const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
	logDebug(`[discord-preflight] shouldRequireMention=${shouldRequireMention} baseRequireMention=${shouldRequireMentionByConfig} boundThreadSession=${isBoundThreadSession} mentionDecision.shouldSkip=${mentionDecision.shouldSkip} wasMentioned=${wasMentioned}`);
	if (isGuildMessage && shouldRequireMention) {
		if (mentionDecision.shouldSkip) {
			logDebug(`[discord-preflight] drop: no-mention`);
			logVerbose(`discord: drop guild message (mention required, botId=${botId ?? "<missing>"})`);
			logger.info({
				channelId: messageChannelId,
				reason: "no-mention"
			}, "discord: skipping guild message");
			recordPendingHistoryEntryIfEnabled({
				historyMap: params.guildHistories,
				historyKey: messageChannelId,
				limit: params.historyLimit,
				entry: historyEntry ?? null
			});
			return null;
		}
	}
	if (author.bot && !sender.isPluralKit && allowBotsMode === "mentions") {
		if (!(isDirectMessage || wasMentioned || mentionDecision.implicitMention)) {
			logDebug(`[discord-preflight] drop: bot message missing mention (allowBots=mentions)`);
			logVerbose("discord: drop bot message (allowBots=mentions, missing mention)");
			return null;
		}
	}
	const ignoreOtherMentions = channelConfig?.ignoreOtherMentions ?? guildInfo?.ignoreOtherMentions ?? false;
	if (isGuildMessage && ignoreOtherMentions && hasUserOrRoleMention && !wasMentioned && !mentionDecision.implicitMention) {
		logDebug(`[discord-preflight] drop: other-mention`);
		logVerbose(`discord: drop guild message (another user/role mentioned, ignoreOtherMentions=true, botId=${botId})`);
		recordPendingHistoryEntryIfEnabled({
			historyMap: params.guildHistories,
			historyKey: messageChannelId,
			limit: params.historyLimit,
			entry: historyEntry ?? null
		});
		return null;
	}
	const systemLocation = resolveDiscordSystemLocation({
		isDirectMessage,
		isGroupDm,
		guild: params.data.guild ?? void 0,
		channelName: channelName ?? messageChannelId
	});
	const { resolveDiscordSystemEvent } = await loadSystemEventsRuntime();
	const systemText = resolveDiscordSystemEvent(message, systemLocation);
	if (systemText) {
		logDebug(`[discord-preflight] drop: system event`);
		enqueueSystemEvent(systemText, {
			sessionKey: effectiveRoute.sessionKey,
			contextKey: `discord:system:${messageChannelId}:${message.id}`
		});
		return null;
	}
	if (!messageText) {
		logDebug(`[discord-preflight] drop: empty content`);
		logVerbose(`discord: drop message ${message.id} (empty content)`);
		return null;
	}
	if (configuredBinding) {
		const ensured = await conversationRuntime.ensureConfiguredBindingRouteReady({
			cfg: params.cfg,
			bindingResolution: configuredBinding
		});
		if (!ensured.ok) {
			logVerbose(`discord: configured ACP binding unavailable for channel ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`);
			return null;
		}
	}
	logDebug(`[discord-preflight] success: route=${effectiveRoute.agentId} sessionKey=${effectiveRoute.sessionKey}`);
	return buildDiscordMessagePreflightContext({
		preflightParams: params,
		data,
		client: params.client,
		message,
		messageChannelId,
		author,
		sender,
		canonicalMessageId: pluralkitInfo?.original?.trim() || void 0,
		memberRoleIds,
		channelInfo,
		channelName,
		isGuildMessage,
		isDirectMessage,
		isGroupDm,
		commandAuthorized,
		baseText,
		messageText,
		...preflightTranscript !== void 0 ? { preflightAudioTranscript: preflightTranscript } : {},
		wasMentioned,
		route: effectiveRoute,
		threadBinding,
		boundSessionKey: boundSessionKey || void 0,
		boundAgentId,
		guildInfo,
		guildSlug,
		threadChannel,
		threadParentId,
		threadParentName,
		threadParentType,
		threadName,
		configChannelName,
		configChannelSlug,
		displayChannelName,
		displayChannelSlug,
		baseSessionKey,
		channelConfig,
		channelAllowlistConfigured,
		channelAllowed,
		shouldRequireMention,
		hasAnyMention,
		allowTextCommands,
		shouldBypassMention: mentionDecision.shouldBypassMention,
		effectiveWasMentioned,
		canDetectMention,
		historyEntry
	});
}
//#endregion
export { preflightDiscordMessage, resolvePreflightMentionRequirement, shouldIgnoreBoundThreadWebhookMessage };
