import { t as normalizeDiscordToken } from "./token-BZtonk7d.js";
import { c as resolveDiscordAccountAllowFrom, d as resolveDiscordAccountDmPolicy, f as resolveDiscordMaxLinesPerMessage, s as resolveDiscordAccount } from "./accounts-CaHGiVB4.js";
import { a as chunkDiscordTextWithMode } from "./normalize-B-ktw-T_.js";
import { a as resolveDiscordComponentEntryWithPersistence, o as resolveDiscordModalEntryWithPersistence, t as editDiscordComponentMessage } from "./send.components-CJ8gYK3s.js";
import { c as setPresence, i as unregisterGateway, r as registerGateway } from "./gateway-registry-BKG4KIVC.js";
import { A as Button, B as Separator, C as User, D as Modal, G as BaseMessageInteractiveComponent, H as TextDisplay, M as Container, R as Row, S as Message, V as StringSelectMenu, a as MessageReactionRemoveListener, b as CommandWithSubcommands, d as Client, f as Plugin, h as RateLimitError, i as MessageReactionAddListener, l as ThreadUpdateListener, n as InteractionCreateListener, o as PresenceUpdateListener, r as MessageCreateListener, s as ReadyListener, t as discord_exports, x as Guild, y as Command } from "./discord-eZlimVfW.js";
import { B as validateDiscordProxyUrl, L as DISCORD_REST_TIMEOUT_MS, N as createDiscordRestClient, R as createDiscordRequestClient, V as withValidatedDiscordProxy, z as resolveDiscordProxyFetchForAccount } from "./send.shared-e9Pd_Em0.js";
import { a as summarizeDiscordResponseBody, i as isDiscordRateLimitResponseBody } from "./api-DzNBVTto.js";
import { n as formatDiscordUserTag, t as formatDiscordReactionEmoji } from "./format-D8TsaXxW.js";
import { _ as resolveGroupDmAllow, a as normalizeDiscordSlug, c as resolveDiscordChannelConfigWithFallback, d as resolveDiscordGuildEntry, f as resolveDiscordMemberAccessState, i as normalizeDiscordDisplaySlug, l as resolveDiscordChannelPolicyCommandAuthorizer, m as resolveDiscordOwnerAccess, n as isDiscordGroupAllowedByPolicy, o as resolveDiscordAllowListMatch, r as normalizeDiscordAllowList, v as shouldEmitDiscordReactionNotification } from "./allow-list-ek-1hMKN.js";
import { t as formatMention } from "./mentions-BPZUaFk7.js";
import { _ as parseDiscordModalCustomIdForInteraction, g as parseDiscordModalCustomId, h as parseDiscordComponentCustomIdForInteraction, m as parseDiscordComponentCustomId } from "./components-D5LnN7ZQ.js";
import { i as isDiscordExecApprovalClientEnabled, n as getDiscordExecApprovalApprovers } from "./approval-shared-GfJeMdLu.js";
import "./approval-native-oN9__F3M.js";
import { t as resolveDiscordConversationIdentity } from "./conversation-identity-BN9wSmxJ.js";
import { t as resolveDiscordChannelAllowlist } from "./resolve-channels-VAqom3Dn.js";
import { t as resolveDiscordUserAllowlist } from "./resolve-users-DPJkRKx1.js";
import { a as isThreadArchived, d as formatThreadBindingDurationLabel } from "./thread-bindings.discord-api-BJF6acLK.js";
import { i as resolveDiscordChannelParentIdSafe, n as resolveDiscordChannelInfoSafe, o as resolveDiscordChannelTopicSafe, r as resolveDiscordChannelNameSafe, t as resolveDiscordChannelIdSafe } from "./channel-access-ewDxhd9q.js";
import { r as parseApplicationIdFromToken, t as fetchDiscordApplicationId } from "./probe-DmHUl6wI.js";
import { o as raceWithTimeout, s as withAbortTimeout } from "./timeouts-C7jeTtGs.js";
import { c as resolveDiscordChannelInfo } from "./message-utils-Dmgu-7fC.js";
import { i as resolveDiscordThreadParentInfo } from "./threading-Bi95Nz8h.js";
import { c as resolveDiscordDmAccessGroupEntries, i as resolveDiscordEffectiveRoute, n as resolveDiscordBoundConversationRoute, o as handleDiscordDmCommandDecision, s as resolveDiscordDmCommandAccess } from "./route-resolution-Bx85WEpX.js";
import { t as resolveDiscordSenderIdentity } from "./sender-identity-BiSDAk2P.js";
import { n as buildDiscordInboundAccessContext, t as buildDiscordGroupSystemPrompt } from "./inbound-context-e_oBBJtF.js";
import { n as resolveDiscordVoiceEnabled, t as authorizeDiscordVoiceIngress } from "./access-B9ujuUtS.js";
import { n as buildDirectLabel, r as buildGuildLabel, t as deliverDiscordReply } from "./reply-delivery-uCiWAyIt.js";
import "./approval-handler.runtime-AZort68o.js";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { chunkItems, logDebug, logError, normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, normalizeOptionalString, normalizeStringEntries, summarizeStringEntries, withTimeout } from "openclaw/plugin-sdk/text-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { ApplicationCommandOptionType, ButtonStyle, ChannelType, ComponentType, GatewayCloseCodes, GatewayCloseCodes as GatewayCloseCodes$1, GatewayDispatchEvents, GatewayIntentBits, GatewayOpcodes } from "discord-api-types/v10";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { inspect } from "node:util";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { resolveSendableOutboundReplyParts, resolveTextChunksWithFallback } from "openclaw/plugin-sdk/reply-payload";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { wrapFetchWithAbortSignal } from "openclaw/plugin-sdk/fetch-runtime";
import { createNonExitingRuntime, createSubsystemLogger, danger, formatDurationSeconds, isVerbose, logVerbose, shouldLogVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { fetchWithSsrFGuard, formatErrorMessage as formatErrorMessage$1 } from "openclaw/plugin-sdk/ssrf-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { addAllowlistUserEntriesFromConfigEntry, buildAllowlistResolutionSummary, canonicalizeAllowlistWithResolvedIds, patchAllowlistUsersInConfigEntries, summarizeMapping } from "openclaw/plugin-sdk/allow-from";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-streaming";
import { buildPairingReply, upsertChannelPairingRequest as upsertChannelPairingRequest$1 } from "openclaw/plugin-sdk/conversation-runtime";
import { clearExpiredCooldowns, ensureAuthProfileStore, isProfileInCooldown, resolveDefaultModelForAgent, resolveHumanDelayConfig, resolveProfilesUnavailableReason } from "openclaw/plugin-sdk/agent-runtime";
import { GROUP_POLICY_BLOCKED_LABEL, resolveDefaultGroupPolicy, resolveOpenProviderRuntimeGroupPolicy, warnMissingProviderGroupPolicyFallbackOnce } from "openclaw/plugin-sdk/runtime-group-policy";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { resolveNativeCommandsEnabled, resolveNativeSkillsEnabled } from "openclaw/plugin-sdk/native-command-config-runtime";
import { readStoreAllowFromForDmPolicy, readStoreAllowFromForDmPolicy as readStoreAllowFromForDmPolicy$1, resolveDmGroupAccessWithLists, resolvePinnedMainDmOwnerFromAllowlist as resolvePinnedMainDmOwnerFromAllowlist$1 } from "openclaw/plugin-sdk/security-runtime";
import { enqueueSystemEvent, enqueueSystemEvent as enqueueSystemEvent$1 } from "openclaw/plugin-sdk/system-event-runtime";
import { applyModelOverrideToSessionEntry } from "openclaw/plugin-sdk/model-session-runtime";
import { loadSessionStore, readSessionUpdatedAt as readSessionUpdatedAt$1, resolveStorePath, resolveStorePath as resolveStorePath$1, updateSessionStore } from "openclaw/plugin-sdk/session-store-runtime";
import { formatInboundEnvelope, resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import { resolveCommandAuthorizedFromAuthorizers, resolveNativeCommandSessionTargets } from "openclaw/plugin-sdk/command-auth-native";
import { buildCommandTextFromArgs, findCommandByNativeName, parseCommandArgs, resolveCommandArgChoices, resolveCommandArgMenu, serializeCommandArgs } from "openclaw/plugin-sdk/native-command-registry";
import { buildCommandTextFromArgs as buildCommandTextFromArgs$1, findCommandByNativeName as findCommandByNativeName$1, formatCommandArgMenuTitle, listChatCommands, listNativeCommandSpecsForConfig, listSkillCommandsForAgents, resolveStoredModelOverride, serializeCommandArgs as serializeCommandArgs$1 } from "openclaw/plugin-sdk/command-auth";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveDirectStatusReplyForSession } from "openclaw/plugin-sdk/command-status-runtime";
import * as pluginRuntime from "openclaw/plugin-sdk/plugin-runtime";
import { createInteractiveConversationBindingHelpers, dispatchPluginInteractiveHandler } from "openclaw/plugin-sdk/plugin-runtime";
import { dispatchReplyWithDispatcher, finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import * as conversationRuntime from "openclaw/plugin-sdk/conversation-binding-runtime";
import os from "node:os";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { createConnectedChannelStatusPatch, createTransportActivityStatusPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { EventEmitter } from "node:events";
import * as ws from "ws";
import * as httpsProxyAgent from "https-proxy-agent";
import { captureHttpExchange, captureWsEvent, resolveDebugProxySettings, resolveEffectiveDebugProxyUrl } from "openclaw/plugin-sdk/proxy-capture";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { ProxyAgent, fetch as fetch$1 } from "undici";
//#region extensions/discord/src/monitor/listeners.queue.ts
const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 3e4;
const discordEventQueueLog = createSubsystemLogger("discord/event-queue");
function formatListenerContextValue(value) {
	if (value === void 0 || value === null) return null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	return null;
}
function formatListenerContextSuffix(context) {
	if (!context) return "";
	const entries = Object.entries(context).flatMap(([key, value]) => {
		const formatted = formatListenerContextValue(value);
		return formatted ? [`${key}=${formatted}`] : [];
	});
	if (entries.length === 0) return "";
	return ` (${entries.join(" ")})`;
}
function logSlowDiscordListener(params) {
	if (params.durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS) return;
	const duration = formatDurationSeconds(params.durationMs, {
		decimals: 1,
		unit: "seconds"
	});
	const message = `Slow listener detected: ${params.listener} took ${duration} for event ${params.event}`;
	(params.logger ?? discordEventQueueLog).warn("Slow listener detected", {
		listener: params.listener,
		event: params.event,
		durationMs: params.durationMs,
		duration,
		...params.context,
		consoleMessage: `${message}${formatListenerContextSuffix(params.context)}`
	});
}
async function runDiscordListenerWithSlowLog(params) {
	const startedAt = Date.now();
	try {
		await params.run();
	} catch (err) {
		if (params.onError) {
			params.onError(err);
			return;
		}
		throw err;
	} finally {
		logSlowDiscordListener({
			logger: params.logger,
			listener: params.listener,
			event: params.event,
			durationMs: Date.now() - startedAt,
			context: params.context
		});
	}
}
//#endregion
//#region extensions/discord/src/monitor/thread-channel-context.ts
function isDiscordThreadChannelType(type) {
	return type === discord_exports.ChannelType.PublicThread || type === discord_exports.ChannelType.PrivateThread || type === discord_exports.ChannelType.AnnouncementThread;
}
function buildFetchedChannelInfo(channel) {
	const channelInfo = resolveDiscordChannelInfoSafe(channel);
	if (channelInfo.type === void 0) return null;
	return {
		type: channelInfo.type,
		name: channelInfo.name,
		topic: channelInfo.topic,
		parentId: channelInfo.parentId,
		ownerId: channelInfo.ownerId
	};
}
async function resolveDiscordThreadLikeChannelContext(params) {
	const safeChannelInfo = resolveDiscordChannelInfoSafe(params.channel);
	const channelId = resolveDiscordChannelIdSafe(params.channel) ?? params.channelIdFallback ?? "";
	const channelInfo = params.channelInfo !== void 0 ? params.channelInfo : channelId ? await resolveDiscordChannelInfo(params.client, channelId) : null;
	const channelType = safeChannelInfo.type ?? channelInfo?.type;
	const channelName = safeChannelInfo.name ?? channelInfo?.name;
	const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
	const parentId = resolveDiscordChannelParentIdSafe(params.channel) ?? channelInfo?.parentId;
	const isThreadChannel = isDiscordThreadChannelType(channelType);
	let threadParentId;
	let threadParentName;
	let threadParentSlug = "";
	if (channelId && isThreadChannel) {
		const parentInfo = await resolveDiscordThreadParentInfo({
			client: params.client,
			threadChannel: {
				id: channelId,
				name: channelName,
				parentId,
				parent: void 0
			},
			channelInfo
		});
		threadParentId = parentInfo.id;
		threadParentName = parentInfo.name;
		threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";
	}
	return {
		channelType,
		isThreadChannel,
		channelId,
		channelName,
		channelSlug,
		parentId,
		threadParentId,
		threadParentName,
		threadParentSlug,
		channelInfo
	};
}
async function resolveFetchedDiscordThreadLikeChannelContext(params) {
	return await resolveDiscordThreadLikeChannelContext({
		...params,
		channelInfo: buildFetchedChannelInfo(params.channel)
	});
}
//#endregion
//#region extensions/discord/src/monitor/listeners.reactions.ts
var DiscordReactionListener = class extends MessageReactionAddListener {
	constructor(params) {
		super();
		this.params = params;
	}
	async handle(data, client) {
		this.params.onEvent?.();
		await runDiscordReactionHandler({
			data,
			client,
			action: "added",
			handlerParams: this.params,
			listener: this.constructor.name,
			event: this.type
		});
	}
};
var DiscordReactionRemoveListener = class extends MessageReactionRemoveListener {
	constructor(params) {
		super();
		this.params = params;
	}
	async handle(data, client) {
		this.params.onEvent?.();
		await runDiscordReactionHandler({
			data,
			client,
			action: "removed",
			handlerParams: this.params,
			listener: this.constructor.name,
			event: this.type
		});
	}
};
async function runDiscordReactionHandler(params) {
	await runDiscordListenerWithSlowLog({
		logger: params.handlerParams.logger,
		listener: params.listener,
		event: params.event,
		run: async () => handleDiscordReactionEvent({
			data: params.data,
			client: params.client,
			action: params.action,
			cfg: params.handlerParams.cfg,
			accountId: params.handlerParams.accountId,
			botUserId: params.handlerParams.botUserId,
			dmEnabled: params.handlerParams.dmEnabled,
			groupDmEnabled: params.handlerParams.groupDmEnabled,
			groupDmChannels: params.handlerParams.groupDmChannels,
			dmPolicy: params.handlerParams.dmPolicy,
			allowFrom: params.handlerParams.allowFrom,
			groupPolicy: params.handlerParams.groupPolicy,
			allowNameMatching: params.handlerParams.allowNameMatching,
			guildEntries: params.handlerParams.guildEntries,
			logger: params.handlerParams.logger
		})
	});
}
async function authorizeDiscordReactionIngress(params) {
	if (params.isDirectMessage && !params.dmEnabled) return {
		allowed: false,
		reason: "dm-disabled"
	};
	if (params.isGroupDm && !params.groupDmEnabled) return {
		allowed: false,
		reason: "group-dm-disabled"
	};
	if (params.isDirectMessage) {
		const storeAllowFrom = await readStoreAllowFromForDmPolicy({
			provider: "discord",
			accountId: params.accountId,
			dmPolicy: params.dmPolicy
		});
		const access = resolveDmGroupAccessWithLists({
			isGroup: false,
			dmPolicy: params.dmPolicy,
			groupPolicy: params.groupPolicy,
			allowFrom: params.allowFrom,
			groupAllowFrom: [],
			storeAllowFrom,
			isSenderAllowed: (allowEntries) => {
				const allowList = normalizeDiscordAllowList(allowEntries, [
					"discord:",
					"user:",
					"pk:"
				]);
				return (allowList ? resolveDiscordAllowListMatch({
					allowList,
					candidate: {
						id: params.user.id,
						name: params.user.username,
						tag: formatDiscordUserTag(params.user)
					},
					allowNameMatching: params.allowNameMatching
				}) : { allowed: false }).allowed;
			}
		});
		if (access.decision !== "allow") return {
			allowed: false,
			reason: access.reason
		};
	}
	if (params.isGroupDm && !resolveGroupDmAllow({
		channels: params.groupDmChannels,
		channelId: params.channelId,
		channelName: params.channelName,
		channelSlug: params.channelSlug
	})) return {
		allowed: false,
		reason: "group-dm-not-allowlisted"
	};
	if (!params.isGuildMessage) return { allowed: true };
	const channelAllowlistConfigured = Boolean(params.guildInfo?.channels) && Object.keys(params.guildInfo?.channels ?? {}).length > 0;
	const channelAllowed = params.channelConfig?.allowed !== false;
	if (!isDiscordGroupAllowedByPolicy({
		groupPolicy: params.groupPolicy,
		guildAllowlisted: Boolean(params.guildInfo),
		channelAllowlistConfigured,
		channelAllowed
	})) return {
		allowed: false,
		reason: "guild-policy"
	};
	if (params.channelConfig?.allowed === false) return {
		allowed: false,
		reason: "guild-channel-denied"
	};
	const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
		channelConfig: params.channelConfig,
		guildInfo: params.guildInfo,
		memberRoleIds: params.memberRoleIds,
		sender: {
			id: params.user.id,
			name: params.user.username,
			tag: formatDiscordUserTag(params.user)
		},
		allowNameMatching: params.allowNameMatching
	});
	if (hasAccessRestrictions && !memberAllowed) return {
		allowed: false,
		reason: "guild-member-denied"
	};
	return { allowed: true };
}
async function handleDiscordThreadReactionNotification(params) {
	if (params.reactionMode === "off") return;
	if (params.reactionMode === "all" || params.reactionMode === "allowlist") {
		const { access, channelConfig } = await params.resolveThreadChannelAccess();
		if (!access.allowed || !params.shouldNotifyReaction({
			mode: params.reactionMode,
			channelConfig
		})) return;
		const { baseText } = params.resolveReactionBase();
		params.emitReaction(baseText, params.parentId);
		return;
	}
	const message = await params.message.fetch().catch(() => null);
	const { access, channelConfig } = await params.resolveThreadChannelAccess();
	const messageAuthorId = message?.author?.id ?? void 0;
	if (!access.allowed || !params.shouldNotifyReaction({
		mode: params.reactionMode,
		messageAuthorId,
		channelConfig
	})) return;
	params.emitReactionWithAuthor(message);
}
async function handleDiscordChannelReactionNotification(params) {
	if (params.isGuildMessage) {
		if (!(await params.authorizeReactionIngressForChannel(params.channelConfig)).allowed) return;
	}
	if (params.reactionMode === "off") return;
	if (params.reactionMode === "all" || params.reactionMode === "allowlist") {
		if (!params.shouldNotifyReaction({
			mode: params.reactionMode,
			channelConfig: params.channelConfig
		})) return;
		const { baseText } = params.resolveReactionBase();
		params.emitReaction(baseText, params.parentId);
		return;
	}
	const message = await params.message.fetch().catch(() => null);
	const messageAuthorId = message?.author?.id ?? void 0;
	if (!params.shouldNotifyReaction({
		mode: params.reactionMode,
		messageAuthorId,
		channelConfig: params.channelConfig
	})) return;
	params.emitReactionWithAuthor(message);
}
function hasDiscordGuildChannelOverrides(guildInfo) {
	return Boolean(guildInfo?.channels && Object.keys(guildInfo.channels).length > 0);
}
function shouldSkipGuildReactionBeforeChannelFetch(params) {
	if (params.reactionMode === "off" || params.groupPolicy === "disabled") return true;
	if (params.reactionMode !== "allowlist") return false;
	if (hasDiscordGuildChannelOverrides(params.guildInfo)) return false;
	return !shouldEmitDiscordReactionNotification({
		mode: params.reactionMode,
		botId: params.botUserId,
		userId: params.user.id,
		userName: params.user.username,
		userTag: formatDiscordUserTag(params.user),
		guildInfo: params.guildInfo,
		memberRoleIds: params.memberRoleIds,
		allowNameMatching: params.allowNameMatching
	});
}
async function handleDiscordReactionEvent(params) {
	try {
		const { data, client, action, botUserId, guildEntries } = params;
		if (!("user" in data)) return;
		const user = data.user;
		if (!user || user.bot) return;
		if (botUserId && user.id === botUserId) return;
		const isGuildMessage = Boolean(data.guild_id);
		const guildInfo = isGuildMessage ? resolveDiscordGuildEntry({
			guild: data.guild ?? void 0,
			guildId: data.guild_id ?? void 0,
			guildEntries
		}) : null;
		if (isGuildMessage && guildEntries && Object.keys(guildEntries).length > 0 && !guildInfo) return;
		const memberRoleIds = Array.isArray(data.rawMember?.roles) ? data.rawMember.roles.map((roleId) => roleId) : [];
		const reactionMode = guildInfo?.reactionNotifications ?? "own";
		if (isGuildMessage && shouldSkipGuildReactionBeforeChannelFetch({
			reactionMode,
			guildInfo,
			groupPolicy: params.groupPolicy,
			memberRoleIds,
			user,
			botUserId,
			allowNameMatching: params.allowNameMatching
		})) return;
		const channel = await client.fetchChannel(data.channel_id);
		if (!channel) return;
		const channelContext = await resolveFetchedDiscordThreadLikeChannelContext({
			client,
			channel,
			channelIdFallback: data.channel_id
		});
		const channelName = channelContext.channelName;
		const channelSlug = channelContext.channelSlug;
		const channelType = channelContext.channelType;
		const isDirectMessage = channelType === discord_exports.ChannelType.DM;
		const isGroupDm = channelType === discord_exports.ChannelType.GroupDM;
		const isThreadChannel = channelContext.isThreadChannel;
		const reactionIngressBase = {
			accountId: params.accountId,
			user,
			memberRoleIds,
			isDirectMessage,
			isGroupDm,
			isGuildMessage,
			channelId: data.channel_id,
			channelName,
			channelSlug,
			dmEnabled: params.dmEnabled,
			groupDmEnabled: params.groupDmEnabled,
			groupDmChannels: params.groupDmChannels,
			dmPolicy: params.dmPolicy,
			allowFrom: params.allowFrom,
			groupPolicy: params.groupPolicy,
			allowNameMatching: params.allowNameMatching,
			guildInfo
		};
		if (!isGuildMessage) {
			const ingressAccess = await authorizeDiscordReactionIngress(reactionIngressBase);
			if (!ingressAccess.allowed) {
				logVerbose(`discord reaction blocked sender=${user.id} (reason=${ingressAccess.reason})`);
				return;
			}
		}
		const parentId = isThreadChannel ? channelContext.threadParentId : channelContext.parentId;
		const parentName = isThreadChannel ? channelContext.threadParentName : void 0;
		const parentSlug = isThreadChannel ? channelContext.threadParentSlug : "";
		let reactionBase = null;
		const resolveReactionBase = () => {
			if (reactionBase) return reactionBase;
			const emojiLabel = formatDiscordReactionEmoji(data.emoji);
			reactionBase = {
				baseText: `Discord reaction ${action}: ${emojiLabel} by ${formatDiscordUserTag(user)} on ${guildInfo?.slug || (data.guild?.name ? normalizeDiscordSlug(data.guild.name) : data.guild_id ?? (isGroupDm ? "group-dm" : "dm"))} ${channelSlug ? `#${channelSlug}` : channelName ? `#${normalizeDiscordSlug(channelName)}` : `#${data.channel_id}`} msg ${data.message_id}`,
				contextKey: `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}`
			};
			return reactionBase;
		};
		const emitReaction = (text, parentPeerId) => {
			const { contextKey } = resolveReactionBase();
			enqueueSystemEvent(text, {
				sessionKey: resolveAgentRoute({
					cfg: params.cfg,
					channel: "discord",
					accountId: params.accountId,
					guildId: data.guild_id ?? void 0,
					memberRoleIds,
					peer: {
						kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
						id: isDirectMessage ? user.id : data.channel_id
					},
					parentPeer: parentPeerId ? {
						kind: "channel",
						id: parentPeerId
					} : void 0
				}).sessionKey,
				contextKey
			});
		};
		const shouldNotifyReaction = (options) => shouldEmitDiscordReactionNotification({
			mode: options.mode,
			botId: botUserId,
			messageAuthorId: options.messageAuthorId,
			userId: user.id,
			userName: user.username,
			userTag: formatDiscordUserTag(user),
			channelConfig: options.channelConfig,
			guildInfo,
			memberRoleIds,
			allowNameMatching: params.allowNameMatching
		});
		const emitReactionWithAuthor = (message) => {
			const { baseText } = resolveReactionBase();
			const authorLabel = message?.author ? formatDiscordUserTag(message.author) : void 0;
			emitReaction(authorLabel ? `${baseText} from ${authorLabel}` : baseText, parentId);
		};
		const resolveThreadChannelConfig = () => resolveDiscordChannelConfigWithFallback({
			guildInfo,
			channelId: data.channel_id,
			channelName,
			channelSlug,
			parentId,
			parentName,
			parentSlug,
			scope: "thread"
		});
		const authorizeReactionIngressForChannel = async (channelConfig) => await authorizeDiscordReactionIngress({
			...reactionIngressBase,
			channelConfig
		});
		const resolveThreadChannelAccess = async () => {
			const channelConfig = resolveThreadChannelConfig();
			return {
				access: await authorizeReactionIngressForChannel(channelConfig),
				channelConfig
			};
		};
		if (isThreadChannel) {
			await handleDiscordThreadReactionNotification({
				reactionMode,
				message: data.message,
				parentId,
				resolveThreadChannelAccess,
				shouldNotifyReaction,
				resolveReactionBase,
				emitReaction,
				emitReactionWithAuthor
			});
			return;
		}
		const channelConfig = resolveDiscordChannelConfigWithFallback({
			guildInfo,
			channelId: data.channel_id,
			channelName,
			channelSlug,
			parentId,
			parentName,
			parentSlug,
			scope: "channel"
		});
		await handleDiscordChannelReactionNotification({
			isGuildMessage,
			reactionMode,
			message: data.message,
			channelConfig,
			parentId,
			authorizeReactionIngressForChannel,
			shouldNotifyReaction,
			resolveReactionBase,
			emitReaction,
			emitReactionWithAuthor
		});
	} catch (err) {
		params.logger.error(danger(`discord reaction handler failed: ${String(err)}`));
	}
}
//#endregion
//#region extensions/discord/src/monitor/thread-session-close.ts
/**
* Marks every session entry in the store whose key contains {@link threadId}
* as "reset" by setting `updatedAt` to 0.
*
* This mirrors how the daily / idle session reset works: zeroing `updatedAt`
* makes `evaluateSessionFreshness` treat the session as stale on the next
* inbound message, so the bot starts a fresh conversation without deleting
* any on-disk transcript history.
*/
async function closeDiscordThreadSessions(params) {
	const { cfg, accountId, threadId } = params;
	const normalizedThreadId = normalizeOptionalLowercaseString(threadId) ?? "";
	if (!normalizedThreadId) return 0;
	const segmentRe = new RegExp(`:${normalizedThreadId}(?::|$)`, "i");
	function sessionKeyContainsThreadId(key) {
		return segmentRe.test(key);
	}
	const storePath = resolveStorePath(cfg.session?.store, { agentId: accountId });
	let resetCount = 0;
	await updateSessionStore(storePath, (store) => {
		for (const [key, entry] of Object.entries(store)) {
			if (!entry || !sessionKeyContainsThreadId(key)) continue;
			if (entry.updatedAt === 0) continue;
			entry.updatedAt = 0;
			resetCount += 1;
		}
		return resetCount;
	});
	return resetCount;
}
//#endregion
//#region extensions/discord/src/monitor/listeners.ts
function registerDiscordListener(listeners, listener) {
	if (listeners.some((existing) => existing.constructor === listener.constructor)) return false;
	listeners.push(listener);
	return true;
}
var DiscordMessageListener = class extends MessageCreateListener {
	constructor(handler, logger, onEvent) {
		super();
		this.handler = handler;
		this.logger = logger;
		this.onEvent = onEvent;
	}
	async handle(data, client) {
		this.onEvent?.();
		Promise.resolve().then(() => this.handler(data, client)).catch((err) => {
			(this.logger ?? discordEventQueueLog).error(danger(`discord handler failed: ${String(err)}`));
		});
	}
};
var DiscordInteractionListener = class extends InteractionCreateListener {
	constructor(logger, onEvent) {
		super();
		this.logger = logger;
		this.onEvent = onEvent;
	}
	async handle(data, client) {
		this.onEvent?.();
		Promise.resolve().then(() => client.handleInteraction(data, {})).catch((err) => {
			(this.logger ?? discordEventQueueLog).error(danger(`discord interaction handler failed: ${String(err)}`));
		});
	}
};
var DiscordPresenceListener = class extends PresenceUpdateListener {
	constructor(params) {
		super();
		this.logger = params.logger;
		this.accountId = params.accountId;
	}
	async handle(data) {
		try {
			const userId = "user" in data && data.user && typeof data.user === "object" && "id" in data.user ? data.user.id : void 0;
			if (!userId) return;
			setPresence(this.accountId, userId, data);
		} catch (err) {
			(this.logger ?? discordEventQueueLog).error(danger(`discord presence handler failed: ${String(err)}`));
		}
	}
};
var DiscordThreadUpdateListener = class extends ThreadUpdateListener {
	constructor(cfg, accountId, logger) {
		super();
		this.cfg = cfg;
		this.accountId = accountId;
		this.logger = logger;
	}
	async handle(data) {
		await runDiscordListenerWithSlowLog({
			logger: this.logger,
			listener: this.constructor.name,
			event: this.type,
			run: async () => {
				if (!isThreadArchived(data)) return;
				const threadId = "id" in data && typeof data.id === "string" ? data.id : void 0;
				if (!threadId) return;
				const logger = this.logger ?? discordEventQueueLog;
				const count = await closeDiscordThreadSessions({
					cfg: this.cfg,
					accountId: this.accountId,
					threadId
				});
				if (count > 0) logger.info("Discord thread archived — reset sessions", {
					threadId,
					count
				});
			},
			onError: (err) => {
				(this.logger ?? discordEventQueueLog).error(danger(`discord thread-update handler failed: ${String(err)}`));
			}
		});
	}
};
//#endregion
//#region extensions/discord/src/monitor/native-command-reply.ts
const DISCORD_EMPTY_VISIBLE_REPLY_WARNING = "⚠️ Command produced no visible reply.";
function isDiscordUnknownInteraction(error) {
	if (!error || typeof error !== "object") return false;
	const err = error;
	if (err.discordCode === 10062 || err.rawBody?.code === 10062) return true;
	if (err.status === 404 && /Unknown interaction/i.test(err.message ?? "")) return true;
	if (/Unknown interaction/i.test(err.rawBody?.message ?? "")) return true;
	return false;
}
function hasRenderableReplyPayload(payload) {
	if (resolveSendableOutboundReplyParts(payload).hasContent) return true;
	const discordData = payload.channelData?.discord;
	if (Array.isArray(discordData?.components) && discordData.components.length > 0) return true;
	return false;
}
async function safeDiscordInteractionCall(label, fn) {
	try {
		return await fn();
	} catch (error) {
		if (isDiscordUnknownInteraction(error)) {
			logVerbose(`discord: ${label} skipped (interaction expired)`);
			return null;
		}
		throw error;
	}
}
async function deliverDiscordInteractionReply(params) {
	const { interaction, payload, textLimit, maxLinesPerMessage, preferFollowUp, chunkMode } = params;
	const reply = resolveSendableOutboundReplyParts(payload);
	const discordData = payload.channelData?.discord;
	let firstMessageComponents = Array.isArray(discordData?.components) && discordData.components.length > 0 ? discordData.components : void 0;
	let hasReplied = false;
	const sendMessage = async (content, files, components) => {
		const contentPayload = content ? { content } : {};
		const payload = files && files.length > 0 ? {
			...contentPayload,
			...components ? { components } : {},
			...params.responseEphemeral !== void 0 ? { ephemeral: params.responseEphemeral } : {},
			files: files.map((file) => {
				if (file.data instanceof Blob) return {
					name: file.name,
					data: file.data
				};
				const arrayBuffer = Uint8Array.from(file.data).buffer;
				return {
					name: file.name,
					data: new Blob([arrayBuffer])
				};
			})
		} : {
			...contentPayload,
			...components ? { components } : {},
			...params.responseEphemeral !== void 0 ? { ephemeral: params.responseEphemeral } : {}
		};
		await safeDiscordInteractionCall("interaction send", async () => {
			if (!preferFollowUp && !hasReplied) {
				await interaction.reply(payload);
				hasReplied = true;
				firstMessageComponents = void 0;
				return;
			}
			await interaction.followUp(payload);
			hasReplied = true;
			firstMessageComponents = void 0;
		});
	};
	if (reply.hasMedia) {
		const media = await Promise.all(reply.mediaUrls.map(async (url) => {
			const loaded = await loadWebMedia(url, { localRoots: params.mediaLocalRoots });
			return {
				name: loaded.fileName ?? "upload",
				data: loaded.buffer
			};
		}));
		const chunks = resolveTextChunksWithFallback(reply.text, chunkDiscordTextWithMode(reply.text, {
			maxChars: textLimit,
			maxLines: maxLinesPerMessage,
			chunkMode
		}));
		await sendMessage(chunks[0] ?? "", media, firstMessageComponents);
		for (const chunk of chunks.slice(1)) {
			if (!chunk.trim()) continue;
			await sendMessage(chunk);
		}
		return;
	}
	if (!reply.hasText && !firstMessageComponents) return;
	let chunks = reply.text || firstMessageComponents ? resolveTextChunksWithFallback(reply.text, chunkDiscordTextWithMode(reply.text, {
		maxChars: textLimit,
		maxLines: maxLinesPerMessage,
		chunkMode
	})) : [];
	if (chunks.length === 0 && firstMessageComponents) chunks = [""];
	for (const chunk of chunks) {
		if (!chunk.trim() && !firstMessageComponents) continue;
		await sendMessage(chunk, void 0, firstMessageComponents);
	}
}
//#endregion
//#region extensions/discord/src/monitor/native-command-route.ts
async function resolveDiscordNativeInteractionRouteState(params) {
	const route = resolveDiscordBoundConversationRoute({
		cfg: params.cfg,
		accountId: params.accountId,
		guildId: params.guildId,
		memberRoleIds: params.memberRoleIds,
		isDirectMessage: params.isDirectMessage,
		isGroupDm: params.isGroupDm,
		directUserId: params.directUserId,
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	});
	const configuredRoute = params.threadBinding == null ? conversationRuntime.resolveConfiguredBindingRoute({
		cfg: params.cfg,
		route,
		conversation: {
			channel: "discord",
			accountId: params.accountId,
			conversationId: params.conversationId,
			parentConversationId: params.parentConversationId
		}
	}) : null;
	const configuredBinding = configuredRoute?.bindingResolution ?? null;
	const configuredBoundSessionKey = normalizeOptionalString(configuredRoute?.boundSessionKey);
	const boundSessionKey = normalizeOptionalString(params.threadBinding?.targetSessionKey) ?? configuredBoundSessionKey;
	return {
		route,
		effectiveRoute: resolveDiscordEffectiveRoute({
			route,
			boundSessionKey,
			configuredRoute,
			matchedBy: configuredBinding ? "binding.channel" : void 0
		}),
		boundSessionKey,
		configuredRoute,
		configuredBinding,
		bindingReadiness: params.enforceConfiguredBindingReadiness && configuredBinding ? await conversationRuntime.ensureConfiguredBindingRouteReady({
			cfg: params.cfg,
			bindingResolution: configuredBinding
		}) : null
	};
}
//#endregion
//#region extensions/discord/src/monitor/native-command.runtime.ts
const nativeCommandRuntime = {
	matchPluginCommand: pluginRuntime.matchPluginCommand,
	executePluginCommand: pluginRuntime.executePluginCommand,
	dispatchReplyWithDispatcher,
	resolveDirectStatusReplyForSession,
	resolveDiscordNativeInteractionRouteState
};
//#endregion
//#region extensions/discord/src/monitor/native-command-agent-reply.ts
async function dispatchDiscordNativeAgentReply(params) {
	const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
		cfg: params.cfg,
		agentId: params.effectiveRoute.agentId,
		channel: "discord",
		accountId: params.effectiveRoute.accountId
	});
	const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(params.discordConfig);
	let didReply = false;
	const dispatchResult = await nativeCommandRuntime.dispatchReplyWithDispatcher({
		ctx: params.ctxPayload,
		cfg: params.cfg,
		dispatcherOptions: {
			...replyPipeline,
			humanDelay: resolveHumanDelayConfig(params.cfg, params.effectiveRoute.agentId),
			deliver: async (payload) => {
				if (params.suppressReplies) return;
				try {
					await deliverDiscordInteractionReply({
						interaction: params.interaction,
						payload,
						mediaLocalRoots: params.mediaLocalRoots,
						textLimit: resolveTextChunkLimit(params.cfg, "discord", params.accountId, { fallbackLimit: 2e3 }),
						maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
							cfg: params.cfg,
							discordConfig: params.discordConfig,
							accountId: params.accountId
						}),
						preferFollowUp: params.preferFollowUp || didReply,
						responseEphemeral: params.responseEphemeral,
						chunkMode: resolveChunkMode(params.cfg, "discord", params.accountId)
					});
				} catch (error) {
					if (isDiscordUnknownInteraction(error)) {
						logVerbose("discord: interaction reply skipped (interaction expired)");
						return;
					}
					throw error;
				}
				didReply = true;
			},
			onError: (err, info) => {
				const message = err instanceof Error ? err.stack ?? err.message : String(err);
				params.log.error(`discord slash ${info.kind} reply failed: ${message}`);
			}
		},
		replyOptions: {
			skillFilter: params.channelConfig?.skills,
			disableBlockStreaming: typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : void 0,
			onModelSelected
		}
	});
	if (params.suppressReplies || didReply || dispatchResult.queuedFinal || dispatchResult.counts.final !== 0 || dispatchResult.counts.block !== 0 || dispatchResult.counts.tool !== 0) return;
	await safeDiscordInteractionCall("interaction empty fallback", async () => {
		const payload = {
			content: DISCORD_EMPTY_VISIBLE_REPLY_WARNING,
			ephemeral: true
		};
		if (params.preferFollowUp) {
			await params.interaction.followUp(payload);
			return;
		}
		await params.interaction.reply(payload);
	});
}
//#endregion
//#region extensions/discord/src/monitor/native-interaction-channel-context.ts
async function resolveDiscordNativeInteractionChannelContext(params) {
	const channelContext = await resolveDiscordThreadLikeChannelContext({
		client: params.client,
		channel: params.channel,
		channelIdFallback: params.channelIdFallback
	});
	const channelType = channelContext.channelType;
	return {
		channelType,
		isDirectMessage: channelType === discord_exports.ChannelType.DM,
		isGroupDm: channelType === discord_exports.ChannelType.GroupDM,
		isThreadChannel: channelContext.isThreadChannel,
		channelName: channelContext.channelName,
		channelSlug: channelContext.channelSlug,
		rawChannelId: channelContext.channelId,
		threadParentId: params.hasGuild ? channelContext.threadParentId : void 0,
		threadParentName: params.hasGuild ? channelContext.threadParentName : void 0,
		threadParentSlug: params.hasGuild ? channelContext.threadParentSlug : ""
	};
}
//#endregion
//#region extensions/discord/src/monitor/native-command-auth.ts
function resolveDiscordNativeCommandAllowlistAccess(params) {
	const commandsAllowFrom = params.cfg.commands?.allowFrom;
	if (!commandsAllowFrom || typeof commandsAllowFrom !== "object") return {
		configured: false,
		allowed: false
	};
	const rawAllowList = Array.isArray(commandsAllowFrom.discord) ? commandsAllowFrom.discord : commandsAllowFrom["*"];
	if (!Array.isArray(rawAllowList)) return {
		configured: false,
		allowed: false
	};
	const guildId = normalizeOptionalString(params.guildId);
	if (guildId) for (const entry of rawAllowList) {
		const text = normalizeOptionalString(String(entry)) ?? "";
		if (text.startsWith("guild:") && text.slice(6) === guildId) return {
			configured: true,
			allowed: true
		};
	}
	const allowList = normalizeDiscordAllowList(rawAllowList.map(String), [
		"discord:",
		"user:",
		"pk:"
	]);
	if (!allowList) return {
		configured: true,
		allowed: false
	};
	return {
		configured: true,
		allowed: resolveDiscordAllowListMatch({
			allowList,
			candidate: params.sender,
			allowNameMatching: false
		}).allowed
	};
}
function resolveDiscordGuildNativeCommandAuthorized(params) {
	const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: params.cfg.channels?.discord !== void 0,
		groupPolicy: params.discordConfig?.groupPolicy,
		defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy
	});
	const policyAuthorizer = resolveDiscordChannelPolicyCommandAuthorizer({
		groupPolicy,
		guildInfo: params.guildInfo,
		channelConfig: params.channelConfig
	});
	if (!policyAuthorizer.allowed) return false;
	const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
		channelConfig: params.channelConfig,
		guildInfo: params.guildInfo,
		memberRoleIds: params.memberRoleIds,
		sender: params.sender,
		allowNameMatching: params.allowNameMatching
	});
	const commandAllowlistAuthorizer = {
		configured: params.commandsAllowFromAccess.configured,
		allowed: params.commandsAllowFromAccess.allowed
	};
	const ownerAuthorizer = {
		configured: params.ownerAllowListConfigured,
		allowed: params.ownerAllowed
	};
	const memberAuthorizer = {
		configured: hasAccessRestrictions,
		allowed: memberAllowed
	};
	const hasStricterAccessRestrictions = ownerAuthorizer.configured || memberAuthorizer.configured;
	const fallbackAuthorizers = [
		{
			configured: policyAuthorizer.configured && !hasStricterAccessRestrictions,
			allowed: policyAuthorizer.allowed
		},
		ownerAuthorizer,
		memberAuthorizer
	];
	const authorizers = params.commandsAllowFromAccess.configured ? [commandAllowlistAuthorizer] : fallbackAuthorizers;
	return resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups: params.useAccessGroups,
		authorizers,
		modeWhenAccessGroupsOff: "configured"
	});
}
function resolveDiscordNativeGroupDmAccess(params) {
	if (!params.isGroupDm) return { allowed: true };
	if (params.groupEnabled === false) return {
		allowed: false,
		reason: "disabled"
	};
	if (!resolveGroupDmAllow({
		channels: params.groupChannels,
		channelId: params.channelId,
		channelName: params.channelName,
		channelSlug: params.channelSlug
	})) return {
		allowed: false,
		reason: "not-allowlisted"
	};
	return { allowed: true };
}
async function resolveDiscordNativeAutocompleteAuthorized(params) {
	const { interaction, cfg, discordConfig, accountId } = params;
	const user = interaction.user;
	if (!user) return false;
	const sender = resolveDiscordSenderIdentity({
		author: user,
		pluralkitInfo: null
	});
	const { isDirectMessage, isGroupDm, isThreadChannel, channelName, channelSlug, rawChannelId, threadParentId, threadParentName, threadParentSlug } = await resolveDiscordNativeInteractionChannelContext({
		channel: interaction.channel,
		client: interaction.client,
		hasGuild: Boolean(interaction.guild),
		channelIdFallback: ""
	});
	const memberRoleIds = Array.isArray(interaction.rawData.member?.roles) ? interaction.rawData.member.roles.map((roleId) => roleId) : [];
	const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const configuredDmAllowFrom = resolveDiscordAccountAllowFrom({
		cfg,
		accountId
	}) ?? [];
	const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
		allowFrom: configuredDmAllowFrom,
		sender: {
			id: sender.id,
			name: sender.name,
			tag: sender.tag
		},
		allowNameMatching
	});
	const commandsAllowFromAccess = resolveDiscordNativeCommandAllowlistAccess({
		cfg,
		accountId,
		sender: {
			id: sender.id,
			name: sender.name,
			tag: sender.tag
		},
		chatType: isDirectMessage ? "direct" : isThreadChannel ? "thread" : interaction.guild ? "channel" : "group",
		conversationId: rawChannelId || void 0,
		guildId: interaction.guild?.id
	});
	const guildInfo = resolveDiscordGuildEntry({
		guild: interaction.guild ?? void 0,
		guildId: interaction.guild?.id ?? void 0,
		guildEntries: discordConfig?.guilds
	});
	const channelConfig = interaction.guild ? resolveDiscordChannelConfigWithFallback({
		guildInfo,
		channelId: rawChannelId,
		channelName,
		channelSlug,
		parentId: threadParentId,
		parentName: threadParentName,
		parentSlug: threadParentSlug,
		scope: isThreadChannel ? "thread" : "channel"
	}) : null;
	if (channelConfig?.enabled === false) return false;
	if (interaction.guild && channelConfig?.allowed === false) return false;
	if (useAccessGroups && interaction.guild) {
		const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
			providerConfigPresent: cfg.channels?.discord !== void 0,
			groupPolicy: discordConfig?.groupPolicy,
			defaultGroupPolicy: cfg.channels?.defaults?.groupPolicy
		});
		if (!resolveDiscordChannelPolicyCommandAuthorizer({
			groupPolicy,
			guildInfo,
			channelConfig
		}).allowed) return false;
	}
	const dmEnabled = discordConfig?.dm?.enabled ?? true;
	const dmPolicy = resolveDiscordAccountDmPolicy({
		cfg,
		accountId
	}) ?? "pairing";
	if (isDirectMessage) {
		if (!dmEnabled || dmPolicy === "disabled") return false;
		if ((await resolveDiscordDmCommandAccess({
			accountId,
			dmPolicy,
			configuredAllowFrom: configuredDmAllowFrom,
			sender: {
				id: sender.id,
				name: sender.name,
				tag: sender.tag
			},
			allowNameMatching,
			useAccessGroups,
			cfg,
			rest: interaction.client.rest
		})).decision !== "allow") return false;
	}
	if (!resolveDiscordNativeGroupDmAccess({
		isGroupDm,
		groupEnabled: discordConfig?.dm?.groupEnabled,
		groupChannels: discordConfig?.dm?.groupChannels,
		channelId: rawChannelId,
		channelName,
		channelSlug
	}).allowed) return false;
	if (!isDirectMessage) return resolveDiscordGuildNativeCommandAuthorized({
		cfg,
		discordConfig,
		useAccessGroups,
		commandsAllowFromAccess,
		guildInfo,
		channelConfig,
		memberRoleIds,
		sender,
		allowNameMatching,
		ownerAllowListConfigured: ownerAllowList != null,
		ownerAllowed: ownerOk
	});
	return true;
}
//#endregion
//#region extensions/discord/src/monitor/native-command-bypass.ts
function shouldBypassConfiguredAcpEnsure(commandName) {
	return normalizeLowercaseStringOrEmpty(commandName) === "acp";
}
function shouldBypassConfiguredAcpGuildGuards(commandName) {
	const normalized = normalizeLowercaseStringOrEmpty(commandName);
	return normalized === "new" || normalized === "reset";
}
//#endregion
//#region extensions/discord/src/monitor/native-command-context.ts
function buildDiscordNativeCommandContext(params) {
	const conversationLabel = params.isDirectMessage ? params.user.globalName ?? params.user.username : params.channelId;
	const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
		channelConfig: params.channelConfig,
		guildInfo: params.guildInfo,
		sender: params.sender,
		allowNameMatching: params.allowNameMatching,
		isGuild: params.isGuild,
		channelTopic: params.channelTopic
	});
	return finalizeInboundContext({
		Body: params.prompt,
		BodyForAgent: params.prompt,
		RawBody: params.prompt,
		CommandBody: params.prompt,
		CommandArgs: params.commandArgs,
		From: params.isDirectMessage ? `discord:${params.user.id}` : params.isGroupDm ? `discord:group:${params.channelId}` : `discord:channel:${params.channelId}`,
		To: `slash:${params.user.id}`,
		SessionKey: params.sessionKey,
		CommandTargetSessionKey: params.commandTargetSessionKey,
		AccountId: params.accountId ?? void 0,
		ChatType: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
		ConversationLabel: conversationLabel,
		GroupSubject: params.isGuild ? params.guildName : void 0,
		GroupSpace: params.isGuild ? params.guildInfo?.id ?? params.guildInfo?.slug ?? params.guildId : void 0,
		MemberRoleIds: params.memberRoleIds,
		GroupSystemPrompt: groupSystemPrompt,
		UntrustedContext: untrustedContext,
		OwnerAllowFrom: ownerAllowFrom,
		SenderName: params.user.globalName ?? params.user.username,
		SenderId: params.user.id,
		SenderUsername: params.user.username,
		SenderTag: params.sender.tag,
		Provider: "discord",
		Surface: "discord",
		WasMentioned: true,
		MessageSid: params.interactionId,
		MessageThreadId: params.isThreadChannel ? params.channelId : void 0,
		Timestamp: params.timestampMs ?? Date.now(),
		CommandAuthorized: params.commandAuthorized,
		CommandSource: "native",
		OriginatingChannel: "discord",
		OriginatingTo: resolveDiscordConversationIdentity({
			isDirectMessage: params.isDirectMessage,
			userId: params.user.id,
			channelId: params.channelId
		}) ?? (params.isDirectMessage ? `user:${params.user.id}` : `channel:${params.channelId}`),
		ThreadParentId: params.isThreadChannel ? params.threadParentId : void 0
	});
}
//#endregion
//#region extensions/discord/src/monitor/native-command-status.ts
async function maybeDeliverDiscordDirectStatus(params) {
	if (params.suppressReplies || params.commandName !== "status") return null;
	const statusReply = await params.resolveDirectStatusReplyForSession({
		cfg: params.cfg,
		sessionKey: params.commandTargetSessionKey?.trim() || params.sessionKey,
		channel: params.channel,
		senderId: params.senderId,
		senderIsOwner: params.senderIsOwner,
		isAuthorizedSender: params.isAuthorizedSender,
		isGroup: params.isGroup,
		defaultGroupActivation: params.defaultGroupActivation
	});
	if (statusReply && hasRenderableReplyPayload(statusReply)) {
		await deliverDiscordInteractionReply({
			interaction: params.interaction,
			payload: statusReply,
			mediaLocalRoots: params.mediaLocalRoots,
			textLimit: resolveTextChunkLimit(params.cfg, "discord", params.accountId, { fallbackLimit: 2e3 }),
			maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
				cfg: params.cfg,
				discordConfig: params.discordConfig,
				accountId: params.accountId
			}),
			preferFollowUp: params.preferFollowUp,
			responseEphemeral: params.responseEphemeral,
			chunkMode: resolveChunkMode(params.cfg, "discord", params.accountId)
		});
		return {
			accepted: true,
			effectiveRoute: params.effectiveRoute
		};
	}
	await params.respond("Status unavailable.");
	return {
		accepted: true,
		effectiveRoute: params.effectiveRoute
	};
}
//#endregion
//#region extensions/discord/src/monitor/commands.ts
function resolveDiscordSlashCommandConfig(raw) {
	return { ephemeral: raw?.ephemeral !== false };
}
//#endregion
//#region extensions/discord/src/monitor/native-command-arg-ui.ts
const DISCORD_COMMAND_ARG_CUSTOM_ID_KEY = "cmdarg";
function createCommandArgsWithValue(params) {
	return { values: { [params.argName]: params.value } };
}
function encodeDiscordCommandArgValue(value) {
	return encodeURIComponent(value);
}
function decodeDiscordCommandArgValue(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
function buildDiscordCommandArgCustomId(params) {
	return [
		`${DISCORD_COMMAND_ARG_CUSTOM_ID_KEY}:command=${encodeDiscordCommandArgValue(params.command)}`,
		`arg=${encodeDiscordCommandArgValue(params.arg)}`,
		`value=${encodeDiscordCommandArgValue(params.value)}`,
		`user=${encodeDiscordCommandArgValue(params.userId)}`
	].join(";");
}
function parseDiscordCommandArgData(data) {
	if (!data || typeof data !== "object") return null;
	const coerce = (value) => typeof value === "string" || typeof value === "number" ? String(value) : "";
	const rawCommand = coerce(data.command);
	const rawArg = coerce(data.arg);
	const rawValue = coerce(data.value);
	const rawUser = coerce(data.user);
	if (!rawCommand || !rawArg || !rawValue || !rawUser) return null;
	return {
		command: decodeDiscordCommandArgValue(rawCommand),
		arg: decodeDiscordCommandArgValue(rawArg),
		value: decodeDiscordCommandArgValue(rawValue),
		userId: decodeDiscordCommandArgValue(rawUser)
	};
}
async function handleDiscordCommandArgInteraction(params) {
	const { interaction, data, ctx } = params;
	const clearWithMessage = async (content) => await params.safeInteractionCall("command arg update", () => interaction.update({
		content,
		components: []
	}));
	const parsed = parseDiscordCommandArgData(data);
	if (!parsed) {
		await clearWithMessage("Sorry, that selection is no longer available.");
		return;
	}
	if (interaction.user?.id && interaction.user.id !== parsed.userId) {
		await params.safeInteractionCall("command arg ack", () => interaction.acknowledge());
		return;
	}
	const commandDefinition = findCommandByNativeName$1(parsed.command, "discord") ?? listChatCommands().find((entry) => entry.key === parsed.command);
	if (!commandDefinition) {
		await clearWithMessage("Sorry, that command is no longer available.");
		return;
	}
	if (await clearWithMessage(`✅ Selected ${parsed.value}.`) === null) return;
	const commandArgs = createCommandArgsWithValue({
		argName: parsed.arg,
		value: parsed.value
	});
	const commandArgsWithRaw = {
		...commandArgs,
		raw: serializeCommandArgs$1(commandDefinition, commandArgs)
	};
	const prompt = buildCommandTextFromArgs$1(commandDefinition, commandArgsWithRaw);
	await params.dispatchCommandInteraction({
		interaction,
		prompt,
		command: commandDefinition,
		commandArgs: commandArgsWithRaw,
		cfg: ctx.cfg,
		discordConfig: ctx.discordConfig,
		accountId: ctx.accountId,
		sessionPrefix: ctx.sessionPrefix,
		preferFollowUp: true,
		threadBindings: ctx.threadBindings,
		responseEphemeral: resolveDiscordSlashCommandConfig(ctx.discordConfig?.slashCommand).ephemeral
	});
}
async function runDiscordCommandArgButton(params) {
	await handleDiscordCommandArgInteraction(params);
}
var DiscordCommandArgButton = class extends Button {
	constructor(params) {
		super();
		this.style = ButtonStyle.Secondary;
		this.label = params.label;
		this.customId = params.customId;
		this.params = params;
	}
	async run(interaction, data) {
		await runDiscordCommandArgButton({
			...this.params,
			interaction,
			data
		});
	}
};
function buildDiscordCommandArgMenu(params) {
	const { command, menu, interaction } = params;
	const commandLabel = command.nativeName ?? command.key;
	const userId = interaction.user?.id ?? "";
	const rows = chunkItems(menu.choices, 4).map((choices) => {
		return new Row(choices.map((choice) => new DiscordCommandArgButton({
			label: choice.label,
			customId: buildDiscordCommandArgCustomId({
				command: commandLabel,
				arg: menu.arg.name,
				value: choice.value,
				userId
			}),
			ctx: params.ctx,
			safeInteractionCall: params.safeInteractionCall,
			dispatchCommandInteraction: params.dispatchCommandInteraction
		})));
	});
	return {
		content: formatCommandArgMenuTitle({
			command,
			menu
		}),
		components: rows
	};
}
var DiscordCommandArgFallbackButton = class extends Button {
	constructor(params) {
		super();
		this.params = params;
		this.label = "cmdarg";
		this.customId = "cmdarg:seed=1";
	}
	async run(interaction, data) {
		await runDiscordCommandArgButton({
			...this.params,
			interaction,
			data
		});
	}
};
function createDiscordCommandArgFallbackButton$1(params) {
	return new DiscordCommandArgFallbackButton(params);
}
//#endregion
//#region extensions/discord/src/monitor/model-picker-preferences.ts
const MODEL_PICKER_PREFERENCES_LOCK_OPTIONS = {
	retries: {
		retries: 8,
		factor: 2,
		minTimeout: 50,
		maxTimeout: 5e3,
		randomize: true
	},
	stale: 15e3
};
const DEFAULT_RECENT_LIMIT = 5;
function sanitizePreferenceEntries(entries) {
	if (!entries || typeof entries !== "object") return {};
	const normalizedEntries = {};
	for (const [key, value] of Object.entries(entries)) {
		if (!value || typeof value !== "object") continue;
		const typedValue = value;
		normalizedEntries[key] = {
			recent: Array.isArray(typedValue.recent) ? typedValue.recent.filter((item) => typeof item === "string") : [],
			updatedAt: typeof typedValue.updatedAt === "string" ? typedValue.updatedAt : ""
		};
	}
	return normalizedEntries;
}
function resolvePreferencesStorePath(env = process.env) {
	const stateDir = resolveStateDir(env, os.homedir);
	return path.join(stateDir, "discord", "model-picker-preferences.json");
}
function normalizeId(value) {
	return normalizeOptionalString(value) ?? "";
}
function buildDiscordModelPickerPreferenceKey(scope) {
	const userId = normalizeId(scope.userId);
	if (!userId) return null;
	const accountId = normalizeAccountId(scope.accountId);
	const guildId = normalizeId(scope.guildId);
	if (guildId) return `discord:${accountId}:guild:${guildId}:user:${userId}`;
	return `discord:${accountId}:dm:user:${userId}`;
}
function normalizeModelRef(raw) {
	const value = raw?.trim();
	if (!value) return null;
	const slashIndex = value.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= value.length - 1) return null;
	const provider = normalizeProviderId(value.slice(0, slashIndex));
	const model = value.slice(slashIndex + 1).trim();
	if (!provider || !model) return null;
	return `${provider}/${model}`;
}
function sanitizeRecentModels(models, limit) {
	const deduped = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of models ?? []) {
		const normalized = normalizeModelRef(item);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		deduped.push(normalized);
		if (deduped.length >= limit) break;
	}
	return deduped;
}
async function readPreferencesStore(filePath) {
	const { value } = await readJsonFileWithFallback(filePath, {
		version: 1,
		entries: {}
	});
	if (!value || typeof value !== "object" || value.version !== 1) return {
		version: 1,
		entries: {}
	};
	return {
		version: 1,
		entries: sanitizePreferenceEntries(value.entries)
	};
}
async function readDiscordModelPickerRecentModels(params) {
	const key = buildDiscordModelPickerPreferenceKey(params.scope);
	if (!key) return [];
	const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
	const entry = (await readPreferencesStore(resolvePreferencesStorePath(params.env))).entries[key];
	const recent = sanitizeRecentModels(entry?.recent, limit);
	if (!params.allowedModelRefs || params.allowedModelRefs.size === 0) return recent;
	return recent.filter((modelRef) => params.allowedModelRefs?.has(modelRef));
}
async function recordDiscordModelPickerRecentModel(params) {
	const key = buildDiscordModelPickerPreferenceKey(params.scope);
	const normalizedModelRef = normalizeModelRef(params.modelRef);
	if (!key || !normalizedModelRef) return;
	const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
	const filePath = resolvePreferencesStorePath(params.env);
	await withFileLock(filePath, MODEL_PICKER_PREFERENCES_LOCK_OPTIONS, async () => {
		const store = await readPreferencesStore(filePath);
		const next = [normalizedModelRef, ...sanitizeRecentModels(store.entries[key]?.recent, limit).filter((entry) => entry !== normalizedModelRef)].slice(0, limit);
		store.entries[key] = {
			recent: next,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await writeJsonFileAtomically(filePath, store);
	});
}
//#endregion
//#region extensions/discord/src/monitor/model-picker.state.ts
const DISCORD_MODEL_PICKER_CUSTOM_ID_KEY = "mdlpk";
const COMMAND_CONTEXTS = ["model", "models"];
const PICKER_ACTIONS = [
	"open",
	"provider",
	"model",
	"runtime",
	"submit",
	"quick",
	"back",
	"reset",
	"cancel",
	"recents"
];
const PICKER_VIEWS = [
	"providers",
	"models",
	"recents"
];
let modelsProviderRuntimePromise;
async function loadModelsProviderRuntime() {
	modelsProviderRuntimePromise ??= import("openclaw/plugin-sdk/models-provider-runtime");
	return await modelsProviderRuntimePromise;
}
function encodeCustomIdValue(value) {
	return encodeURIComponent(value);
}
function decodeCustomIdValue$1(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
function isValidCommandContext(value) {
	return COMMAND_CONTEXTS.includes(value);
}
function isValidPickerAction(value) {
	return PICKER_ACTIONS.includes(value);
}
function isValidPickerView(value) {
	return PICKER_VIEWS.includes(value);
}
function normalizeModelPickerPage(value) {
	const numeric = typeof value === "number" ? value : NaN;
	if (!Number.isFinite(numeric)) return 1;
	return Math.max(1, Math.floor(numeric));
}
function parseRawPage(value) {
	if (typeof value === "number") return normalizeModelPickerPage(value);
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return normalizeModelPickerPage(parsed);
	}
	return 1;
}
function parseRawPositiveInt(value) {
	if (typeof value !== "string" && typeof value !== "number") return;
	const parsed = Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed) || parsed < 1) return;
	return Math.floor(parsed);
}
function coerceString(value) {
	return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function clampPageSize(rawPageSize, max, fallback) {
	if (!Number.isFinite(rawPageSize)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(rawPageSize ?? fallback)));
}
function paginateItems(params) {
	const totalItems = params.items.length;
	const totalPages = Math.max(1, Math.ceil(totalItems / params.pageSize));
	const page = Math.max(1, Math.min(params.page, totalPages));
	const startIndex = (page - 1) * params.pageSize;
	const endIndexExclusive = Math.min(totalItems, startIndex + params.pageSize);
	return {
		items: params.items.slice(startIndex, endIndexExclusive),
		page,
		pageSize: params.pageSize,
		totalPages,
		totalItems,
		hasPrev: page > 1,
		hasNext: page < totalPages
	};
}
async function loadDiscordModelPickerData(cfg, agentId) {
	const { buildModelsProviderData } = await loadModelsProviderRuntime();
	return buildModelsProviderData(cfg, agentId);
}
function buildDiscordModelPickerCustomId(params) {
	const userId = params.userId.trim();
	if (!userId) throw new Error("Discord model picker custom_id requires userId");
	const page = normalizeModelPickerPage(params.page);
	const providerPage = typeof params.providerPage === "number" && Number.isFinite(params.providerPage) ? Math.max(1, Math.floor(params.providerPage)) : void 0;
	const normalizedProvider = params.provider ? normalizeProviderId(params.provider) : void 0;
	const modelIndex = typeof params.modelIndex === "number" && Number.isFinite(params.modelIndex) ? Math.max(1, Math.floor(params.modelIndex)) : void 0;
	const recentSlot = typeof params.recentSlot === "number" && Number.isFinite(params.recentSlot) ? Math.max(1, Math.floor(params.recentSlot)) : void 0;
	const parts = [
		`${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:c=${encodeCustomIdValue(params.command)}`,
		`a=${encodeCustomIdValue(params.action)}`,
		`v=${encodeCustomIdValue(params.view)}`,
		`u=${encodeCustomIdValue(userId)}`,
		`g=${String(page)}`
	];
	if (normalizedProvider) parts.push(`p=${encodeCustomIdValue(normalizedProvider)}`);
	const runtime = params.runtime?.trim();
	if (runtime) parts.push(`r=${encodeCustomIdValue(runtime)}`);
	if (providerPage) parts.push(`pp=${String(providerPage)}`);
	if (modelIndex) parts.push(`mi=${String(modelIndex)}`);
	if (recentSlot) parts.push(`rs=${String(recentSlot)}`);
	const customId = parts.join(";");
	if (customId.length > 100) throw new Error(`Discord model picker custom_id exceeds 100 chars (${customId.length})`);
	return customId;
}
function parseDiscordModelPickerData(data) {
	if (!data || typeof data !== "object") return null;
	const command = decodeCustomIdValue$1(coerceString(data.c ?? data.cmd));
	const action = decodeCustomIdValue$1(coerceString(data.a ?? data.act));
	const view = decodeCustomIdValue$1(coerceString(data.v ?? data.view));
	const userId = decodeCustomIdValue$1(coerceString(data.u));
	const providerRaw = decodeCustomIdValue$1(coerceString(data.p));
	const runtimeRaw = decodeCustomIdValue$1(coerceString(data.r));
	const page = parseRawPage(data.g ?? data.pg);
	const providerPage = parseRawPositiveInt(data.pp);
	const modelIndex = parseRawPositiveInt(data.mi);
	const recentSlot = parseRawPositiveInt(data.rs);
	if (!isValidCommandContext(command) || !isValidPickerAction(action) || !isValidPickerView(view)) return null;
	const trimmedUserId = userId.trim();
	if (!trimmedUserId) return null;
	return {
		command,
		action,
		view,
		userId: trimmedUserId,
		provider: providerRaw ? normalizeProviderId(providerRaw) : void 0,
		runtime: runtimeRaw.trim() || void 0,
		page,
		...typeof providerPage === "number" ? { providerPage } : {},
		...typeof modelIndex === "number" ? { modelIndex } : {},
		...typeof recentSlot === "number" ? { recentSlot } : {}
	};
}
function buildDiscordModelPickerProviderItems(data) {
	return data.providers.map((provider) => ({
		id: provider,
		count: data.byProvider.get(provider)?.size ?? 0
	}));
}
function getDiscordModelPickerProviderPage(params) {
	const items = buildDiscordModelPickerProviderItems(params.data);
	const maxPageSize = items.length <= 25 ? 25 : 20;
	const pageSize = clampPageSize(params.pageSize, maxPageSize, maxPageSize);
	return paginateItems({
		items,
		page: normalizeModelPickerPage(params.page),
		pageSize
	});
}
function getDiscordModelPickerModelPage(params) {
	const provider = normalizeProviderId(params.provider);
	const modelSet = params.data.byProvider.get(provider);
	if (!modelSet) return null;
	const pageSize = clampPageSize(params.pageSize, 25, 25);
	return {
		...paginateItems({
			items: [...modelSet].toSorted(),
			page: normalizeModelPickerPage(params.page),
			pageSize
		}),
		provider
	};
}
//#endregion
//#region extensions/discord/src/monitor/model-picker.view.ts
const DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS = 18;
function parseCurrentModelRef(raw) {
	const match = (raw?.trim())?.match(/^([^/]+)\/(.+)$/u);
	if (!match) return null;
	const provider = normalizeProviderId(match[1]);
	const model = match[2];
	if (!provider || !model) return null;
	return {
		provider,
		model
	};
}
function formatCurrentModelLine(currentModel) {
	const parsed = parseCurrentModelRef(currentModel);
	if (!parsed) return "Current model: default";
	return `Current model: ${parsed.provider}/${parsed.model}`;
}
function formatProviderButtonLabel(provider) {
	if (provider.length <= DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS) return provider;
	return `${provider.slice(0, DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS - 1)}…`;
}
function chunkProvidersForRows(items) {
	if (items.length === 0) return [];
	const rowCount = Math.max(1, Math.ceil(items.length / 5));
	const minPerRow = Math.floor(items.length / rowCount);
	const rowsWithExtraItem = items.length % rowCount;
	const counts = Array.from({ length: rowCount }, (_, index) => index < rowCount - rowsWithExtraItem ? minPerRow : minPerRow + 1);
	const rows = [];
	let cursor = 0;
	for (const count of counts) {
		rows.push(items.slice(cursor, cursor + count));
		cursor += count;
	}
	return rows;
}
function createModelPickerButton(params) {
	class DiscordModelPickerButton extends Button {
		constructor(..._args) {
			super(..._args);
			this.label = params.label;
			this.customId = params.customId;
			this.style = params.style ?? ButtonStyle.Secondary;
			this.disabled = params.disabled ?? false;
		}
	}
	return new DiscordModelPickerButton();
}
function createModelSelect(params) {
	class DiscordModelPickerSelect extends StringSelectMenu {
		constructor(..._args2) {
			super(..._args2);
			this.customId = params.customId;
			this.options = params.options;
			this.minValues = 1;
			this.maxValues = 1;
			this.placeholder = params.placeholder;
			this.disabled = params.disabled ?? false;
		}
	}
	return new DiscordModelPickerSelect();
}
function getRuntimeChoices(params) {
	return params.data.runtimeChoicesByProvider?.get(normalizeProviderId(params.provider)) ?? [{
		id: "pi",
		label: "OpenClaw Pi Default",
		description: "Use the built-in OpenClaw Pi runtime."
	}];
}
function resolveSelectedRuntime(params) {
	const choices = getRuntimeChoices({
		data: params.data,
		provider: params.provider
	});
	const allowed = new Set(choices.map((choice) => choice.id));
	const pending = params.pendingRuntime?.trim();
	if (pending && allowed.has(pending)) return pending;
	const current = params.currentRuntime?.trim();
	return current && allowed.has(current) ? current : "pi";
}
function buildRenderedShell(params) {
	if (params.layout === "classic") return {
		layout: "classic",
		content: [
			params.title,
			...params.detailLines,
			"",
			params.footer
		].filter(Boolean).join("\n"),
		components: params.rows
	};
	const containerComponents = [new TextDisplay(`## ${params.title}`)];
	if (params.detailLines.length > 0) containerComponents.push(new TextDisplay(params.detailLines.join("\n")));
	containerComponents.push(new Separator({
		divider: true,
		spacing: "small"
	}));
	if (params.preRowText) containerComponents.push(new TextDisplay(params.preRowText));
	containerComponents.push(...params.rows);
	if (params.trailingRows && params.trailingRows.length > 0) {
		containerComponents.push(new Separator({
			divider: true,
			spacing: "small"
		}));
		containerComponents.push(...params.trailingRows);
	}
	if (params.footer) {
		containerComponents.push(new Separator({
			divider: false,
			spacing: "small"
		}));
		containerComponents.push(new TextDisplay(`-# ${params.footer}`));
	}
	return {
		layout: "v2",
		components: [new Container(containerComponents)]
	};
}
function buildProviderRows(params) {
	return chunkProvidersForRows(params.page.items).map((providers) => new Row(providers.map((provider) => {
		const style = provider.id === params.currentProvider ? ButtonStyle.Primary : ButtonStyle.Secondary;
		return createModelPickerButton({
			label: formatProviderButtonLabel(provider.id),
			style,
			customId: buildDiscordModelPickerCustomId({
				command: params.command,
				action: "provider",
				view: "models",
				provider: provider.id,
				page: params.page.page,
				userId: params.userId
			})
		});
	})));
}
function buildModelRows(params) {
	const parsedCurrentModel = parseCurrentModelRef(params.currentModel);
	const parsedPendingModel = parseCurrentModelRef(params.pendingModel);
	const rows = [];
	const hasQuickModels = (params.quickModels ?? []).length > 0;
	const providerPage = getDiscordModelPickerProviderPage({
		data: params.data,
		page: params.providerPage
	});
	const providerOptions = providerPage.items.map((provider) => ({
		label: provider.id,
		value: provider.id,
		default: provider.id === params.modelPage.provider
	}));
	rows.push(new Row([createModelSelect({
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "provider",
			view: "models",
			provider: params.modelPage.provider,
			page: providerPage.page,
			providerPage: providerPage.page,
			userId: params.userId
		}),
		options: providerOptions,
		placeholder: "Select provider"
	})]));
	const runtimeChoices = getRuntimeChoices({
		data: params.data,
		provider: params.modelPage.provider
	});
	const selectedRuntime = resolveSelectedRuntime({
		data: params.data,
		provider: params.modelPage.provider,
		currentRuntime: params.currentRuntime,
		pendingRuntime: params.pendingRuntime
	});
	const normalizedCurrentRuntime = params.currentRuntime?.trim();
	const stateRuntime = runtimeChoices.length > 1 || Boolean(normalizedCurrentRuntime) && normalizedCurrentRuntime !== "auto" && normalizedCurrentRuntime !== "pi" && normalizedCurrentRuntime !== "default" ? selectedRuntime : void 0;
	if (runtimeChoices.length > 1) rows.push(new Row([createModelSelect({
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "runtime",
			view: "models",
			provider: params.modelPage.provider,
			runtime: selectedRuntime,
			page: params.modelPage.page,
			providerPage: providerPage.page,
			modelIndex: params.pendingModelIndex,
			userId: params.userId
		}),
		options: runtimeChoices.map((choice) => {
			const option = {
				label: choice.label,
				value: choice.id,
				default: choice.id === selectedRuntime
			};
			if (choice.description) option.description = choice.description;
			return option;
		}),
		placeholder: "Select runtime"
	})]));
	const selectedModelRef = parsedPendingModel ?? parsedCurrentModel;
	const modelOptions = params.modelPage.items.map((model) => ({
		label: model,
		value: model,
		default: selectedModelRef ? selectedModelRef.provider === params.modelPage.provider && selectedModelRef.model === model : false
	}));
	rows.push(new Row([createModelSelect({
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "model",
			view: "models",
			provider: params.modelPage.provider,
			runtime: stateRuntime,
			page: params.modelPage.page,
			providerPage: providerPage.page,
			userId: params.userId
		}),
		options: modelOptions,
		placeholder: `Select ${params.modelPage.provider} model`
	})]));
	const resolvedDefault = params.data.resolvedDefault;
	const shouldDisableReset = Boolean(parsedCurrentModel) && parsedCurrentModel?.provider === resolvedDefault.provider && parsedCurrentModel?.model === resolvedDefault.model;
	const hasPendingSelection = Boolean(parsedPendingModel) && parsedPendingModel?.provider === params.modelPage.provider && typeof params.pendingModelIndex === "number" && params.pendingModelIndex > 0;
	const buttonRowItems = [createModelPickerButton({
		label: "Cancel",
		style: ButtonStyle.Secondary,
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "cancel",
			view: "models",
			provider: params.modelPage.provider,
			runtime: stateRuntime,
			page: params.modelPage.page,
			providerPage: providerPage.page,
			userId: params.userId
		})
	}), createModelPickerButton({
		label: "Reset to default",
		style: ButtonStyle.Secondary,
		disabled: shouldDisableReset,
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "reset",
			view: "models",
			provider: params.modelPage.provider,
			runtime: stateRuntime,
			page: params.modelPage.page,
			providerPage: providerPage.page,
			userId: params.userId
		})
	})];
	if (hasQuickModels) buttonRowItems.push(createModelPickerButton({
		label: "Recents",
		style: ButtonStyle.Secondary,
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "recents",
			view: "recents",
			provider: params.modelPage.provider,
			runtime: stateRuntime,
			page: params.modelPage.page,
			providerPage: providerPage.page,
			userId: params.userId
		})
	}));
	buttonRowItems.push(createModelPickerButton({
		label: "Submit",
		style: ButtonStyle.Primary,
		disabled: !hasPendingSelection,
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "submit",
			view: "models",
			provider: params.modelPage.provider,
			runtime: stateRuntime,
			page: params.modelPage.page,
			providerPage: providerPage.page,
			modelIndex: params.pendingModelIndex,
			userId: params.userId
		})
	}));
	return {
		rows,
		buttonRow: new Row(buttonRowItems)
	};
}
function renderDiscordModelPickerProvidersView(params) {
	const page = getDiscordModelPickerProviderPage({
		data: params.data,
		page: params.page
	});
	const parsedCurrent = parseCurrentModelRef(params.currentModel);
	const rows = buildProviderRows({
		command: params.command,
		userId: params.userId,
		page,
		currentProvider: parsedCurrent?.provider
	});
	const detailLines = [formatCurrentModelLine(params.currentModel), `Select a provider (${page.totalItems} available).`];
	return buildRenderedShell({
		layout: params.layout ?? "v2",
		title: "Model Picker",
		detailLines,
		rows,
		footer: `All ${page.totalItems} providers shown`
	});
}
function renderDiscordModelPickerModelsView(params) {
	const providerPage = normalizeModelPickerPage(params.providerPage);
	const modelPage = getDiscordModelPickerModelPage({
		data: params.data,
		provider: params.provider,
		page: params.page
	});
	if (!modelPage) {
		const rows = [new Row([createModelPickerButton({
			label: "Back",
			customId: buildDiscordModelPickerCustomId({
				command: params.command,
				action: "back",
				view: "providers",
				page: providerPage,
				userId: params.userId
			})
		})])];
		return buildRenderedShell({
			layout: params.layout ?? "v2",
			title: "Model Picker",
			detailLines: [formatCurrentModelLine(params.currentModel), `Provider not found: ${normalizeProviderId(params.provider)}`],
			rows,
			footer: "Choose a different provider."
		});
	}
	const { rows, buttonRow } = buildModelRows({
		command: params.command,
		userId: params.userId,
		data: params.data,
		providerPage,
		modelPage,
		currentModel: params.currentModel,
		pendingModel: params.pendingModel,
		pendingModelIndex: params.pendingModelIndex,
		currentRuntime: params.currentRuntime,
		pendingRuntime: params.pendingRuntime,
		quickModels: params.quickModels
	});
	const defaultModel = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
	const pendingLine = params.pendingModel ? `Selected: ${params.pendingModel} · runtime ${resolveSelectedRuntime({
		data: params.data,
		provider: modelPage.provider,
		currentRuntime: params.currentRuntime,
		pendingRuntime: params.pendingRuntime
	})} (press Submit)` : "Select a model, then press Submit.";
	return buildRenderedShell({
		layout: params.layout ?? "v2",
		title: "Model Picker",
		detailLines: [formatCurrentModelLine(params.currentModel), `Default: ${defaultModel}`],
		preRowText: pendingLine,
		rows,
		trailingRows: [buttonRow]
	});
}
function formatRecentsButtonLabel(modelRef, suffix) {
	const maxLen = 80;
	const label = suffix ? `${modelRef} ${suffix}` : modelRef;
	if (label.length <= maxLen) return label;
	return suffix ? `${modelRef.slice(0, maxLen - suffix.length - 2)}… ${suffix}` : `${modelRef.slice(0, maxLen - 1)}…`;
}
function renderDiscordModelPickerRecentsView(params) {
	const defaultModelRef = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
	const rows = [];
	const dedupedQuickModels = params.quickModels.filter((modelRef) => modelRef !== defaultModelRef);
	rows.push(new Row([createModelPickerButton({
		label: formatRecentsButtonLabel(defaultModelRef, "(default)"),
		style: ButtonStyle.Secondary,
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "submit",
			view: "recents",
			recentSlot: 1,
			provider: params.provider,
			page: params.page,
			providerPage: params.providerPage,
			userId: params.userId
		})
	})]));
	for (let i = 0; i < dedupedQuickModels.length; i++) {
		const modelRef = dedupedQuickModels[i];
		rows.push(new Row([createModelPickerButton({
			label: formatRecentsButtonLabel(modelRef),
			style: ButtonStyle.Secondary,
			customId: buildDiscordModelPickerCustomId({
				command: params.command,
				action: "submit",
				view: "recents",
				recentSlot: i + 2,
				provider: params.provider,
				page: params.page,
				providerPage: params.providerPage,
				userId: params.userId
			})
		})]));
	}
	const backRow = new Row([createModelPickerButton({
		label: "Back",
		style: ButtonStyle.Secondary,
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "back",
			view: "models",
			provider: params.provider,
			page: params.page,
			providerPage: params.providerPage,
			userId: params.userId
		})
	})]);
	return buildRenderedShell({
		layout: params.layout ?? "v2",
		title: "Recents",
		detailLines: ["Models you've previously selected appear here.", formatCurrentModelLine(params.currentModel)],
		preRowText: "Tap a model to switch.",
		rows,
		trailingRows: [backRow]
	});
}
function toDiscordModelPickerMessagePayload(view) {
	if (view.layout === "classic") return {
		content: view.content,
		components: view.components
	};
	return { components: view.components };
}
//#endregion
//#region extensions/discord/src/monitor/native-command-model-picker-apply.ts
async function persistDiscordModelPickerOverride(params) {
	const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.route.agentId });
	let persisted = false;
	await updateSessionStore(storePath, (store) => {
		const entry = store[params.route.sessionKey];
		if (!entry) return;
		persisted = applyModelOverrideToSessionEntry({
			entry,
			selection: {
				provider: params.provider,
				model: params.model,
				isDefault: params.isDefault
			},
			markLiveSwitchPending: true
		}).updated || persisted;
	});
	return persisted;
}
async function applyDiscordModelPickerSelection(params) {
	try {
		const dispatchResult = await withTimeout(params.dispatchCommandInteraction({
			interaction: params.interaction,
			prompt: params.selectionCommand.prompt,
			command: params.selectionCommand.command,
			commandArgs: params.selectionCommand.args,
			cfg: params.cfg,
			discordConfig: params.discordConfig,
			accountId: params.accountId,
			sessionPrefix: params.sessionPrefix,
			preferFollowUp: true,
			threadBindings: params.threadBindings,
			suppressReplies: true
		}), 12e3);
		if (!dispatchResult.accepted) return {
			status: "rejected",
			noticeMessage: `❌ Failed to apply ${params.resolvedModelRef}. Try /model ${params.resolvedModelRef} directly.`
		};
		const fallbackRoute = dispatchResult.effectiveRoute ?? params.route;
		if (params.settleMs > 0) await new Promise((resolve) => setTimeout(resolve, params.settleMs));
		let effectiveModelRef = params.resolveCurrentModel(fallbackRoute);
		let persisted = effectiveModelRef === params.resolvedModelRef;
		if (!persisted) {
			logVerbose(`discord: model picker override mismatch — expected ${params.resolvedModelRef} but read ${effectiveModelRef} from session key ${fallbackRoute.sessionKey}; attempting direct session override persist`);
			try {
				const directlyPersisted = await persistDiscordModelPickerOverride({
					cfg: params.cfg,
					route: fallbackRoute,
					provider: params.selectedProvider,
					model: params.selectedModel,
					isDefault: params.selectedProvider === params.defaultProvider && params.selectedModel === params.defaultModel
				});
				await new Promise((resolve) => setTimeout(resolve, 100));
				effectiveModelRef = params.resolveCurrentModel(fallbackRoute);
				persisted = effectiveModelRef === params.resolvedModelRef;
				if (!persisted) logVerbose(`discord: direct session override persist failed — expected ${params.resolvedModelRef} but read ${effectiveModelRef} from session key ${fallbackRoute.sessionKey}`);
				else if (!directlyPersisted) logVerbose(`discord: direct session override persist became a no-op because ${params.resolvedModelRef} was already present on re-read for session key ${fallbackRoute.sessionKey}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logVerbose(`discord: direct session override persist threw for session key ${fallbackRoute.sessionKey}: ${message}`);
			}
		}
		if (persisted) await recordDiscordModelPickerRecentModel({
			scope: params.preferenceScope,
			modelRef: params.resolvedModelRef,
			limit: 5
		}).catch(() => void 0);
		return persisted ? {
			status: "success",
			effectiveModelRef,
			noticeMessage: `✅ Model set to ${params.resolvedModelRef}.`
		} : {
			status: "mismatch",
			effectiveModelRef,
			noticeMessage: `⚠️ Tried to set ${params.resolvedModelRef}, but current model is ${effectiveModelRef}.`
		};
	} catch (error) {
		if (error instanceof Error && error.message === "timeout") return {
			status: "timeout",
			noticeMessage: `⏳ Model change to ${params.resolvedModelRef} is still processing. Check /status in a few seconds.`
		};
		return {
			status: "failed",
			noticeMessage: `❌ Failed to apply ${params.resolvedModelRef}. Try /model ${params.resolvedModelRef} directly.`
		};
	}
}
//#endregion
//#region extensions/discord/src/monitor/native-command-model-picker-ui.ts
function resolveDiscordModelPickerCommandContext(command) {
	const normalized = normalizeLowercaseStringOrEmpty(command.nativeName ?? command.key);
	if (normalized === "model" || normalized === "models") return normalized;
	return null;
}
function resolveCommandArgStringValue(args, key) {
	const value = args?.values?.[key];
	if (typeof value !== "string") return "";
	return value.trim();
}
function shouldOpenDiscordModelPickerFromCommand(params) {
	const context = resolveDiscordModelPickerCommandContext(params.command);
	if (!context) return null;
	const serializedArgs = normalizeOptionalString(serializeCommandArgs$1(params.command, params.commandArgs)) ?? "";
	if (context === "model") return !resolveCommandArgStringValue(params.commandArgs, "model") && !serializedArgs ? context : null;
	return serializedArgs ? null : context;
}
function buildDiscordModelPickerCurrentModel(defaultProvider, defaultModel) {
	return `${defaultProvider}/${defaultModel}`;
}
function resolveConfiguredAgentRuntimeId(value) {
	return normalizeOptionalString(value.agentRuntime?.id);
}
function buildDiscordModelPickerAllowedModelRefs(data) {
	const out = /* @__PURE__ */ new Set();
	for (const provider of data.providers) {
		const models = data.byProvider.get(provider);
		if (!models) continue;
		for (const model of models) out.add(`${provider}/${model}`);
	}
	return out;
}
function resolveDiscordModelPickerPreferenceScope(params) {
	return {
		accountId: params.accountId,
		guildId: params.interaction.guild?.id ?? void 0,
		userId: params.userId
	};
}
function buildDiscordModelPickerNoticePayload(message) {
	return { components: [new Container([new TextDisplay(message)])] };
}
async function resolveDiscordModelPickerRouteState(params) {
	const { interaction, cfg, accountId } = params;
	const { isDirectMessage, isGroupDm, isThreadChannel, rawChannelId, threadParentId } = await resolveDiscordNativeInteractionChannelContext({
		channel: interaction.channel,
		client: interaction.client,
		hasGuild: Boolean(interaction.guild),
		channelIdFallback: "unknown"
	});
	const memberRoleIds = Array.isArray(interaction.rawData.member?.roles) ? interaction.rawData.member.roles.map((roleId) => roleId) : [];
	const threadBinding = isThreadChannel ? params.threadBindings.getByThreadId(rawChannelId) : void 0;
	return await resolveDiscordNativeInteractionRouteState({
		cfg,
		accountId,
		guildId: interaction.guild?.id ?? void 0,
		memberRoleIds,
		isDirectMessage,
		isGroupDm,
		directUserId: interaction.user?.id ?? rawChannelId,
		conversationId: rawChannelId,
		parentConversationId: threadParentId,
		threadBinding,
		enforceConfiguredBindingReadiness: params.enforceConfiguredBindingReadiness
	});
}
async function resolveDiscordModelPickerRoute(params) {
	return (await resolveDiscordModelPickerRouteState(params)).effectiveRoute;
}
async function resolveDiscordNativeChoiceContext(params) {
	try {
		const resolved = await resolveDiscordModelPickerRouteState({
			interaction: params.interaction,
			cfg: params.cfg,
			accountId: params.accountId,
			threadBindings: params.threadBindings,
			enforceConfiguredBindingReadiness: true
		});
		if (resolved.bindingReadiness && !resolved.bindingReadiness.ok) return null;
		const route = resolved.effectiveRoute;
		const fallback = resolveDefaultModelForAgent({
			cfg: params.cfg,
			agentId: route.agentId
		});
		const sessionStore = loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId: route.agentId }));
		const sessionEntry = sessionStore[route.sessionKey];
		const override = resolveStoredModelOverride({
			sessionEntry,
			sessionStore,
			sessionKey: route.sessionKey,
			defaultProvider: fallback.provider
		});
		if (!override?.model) return {
			provider: fallback.provider,
			model: fallback.model
		};
		return {
			provider: override.provider || fallback.provider,
			model: override.model
		};
	} catch {
		return null;
	}
}
function resolveDiscordModelPickerCurrentModel(params) {
	const fallback = buildDiscordModelPickerCurrentModel(params.data.resolvedDefault.provider, params.data.resolvedDefault.model);
	try {
		const sessionStore = loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId: params.route.agentId }), { skipCache: true });
		const sessionEntry = sessionStore[params.route.sessionKey];
		const override = resolveStoredModelOverride({
			sessionEntry,
			sessionStore,
			sessionKey: params.route.sessionKey,
			defaultProvider: params.data.resolvedDefault.provider
		});
		if (!override?.model) return fallback;
		const provider = (override.provider || params.data.resolvedDefault.provider).trim();
		if (!provider) return fallback;
		return `${provider}/${override.model}`;
	} catch {
		return fallback;
	}
}
function resolveDiscordModelPickerCurrentRuntime(params) {
	try {
		const sessionRuntime = normalizeOptionalString(loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId: params.route.agentId }), { skipCache: true })[params.route.sessionKey]?.agentRuntimeOverride);
		if (sessionRuntime) return sessionRuntime;
	} catch {}
	const agentRuntime = resolveConfiguredAgentRuntimeId(params.cfg.agents?.list?.find((entry) => normalizeOptionalString(entry.id) === params.route.agentId) ?? {});
	if (agentRuntime) return agentRuntime;
	return resolveConfiguredAgentRuntimeId(params.cfg.agents?.defaults ?? {}) ?? "auto";
}
async function replyWithDiscordModelPickerProviders(params) {
	const route = await resolveDiscordModelPickerRoute({
		interaction: params.interaction,
		cfg: params.cfg,
		accountId: params.accountId,
		threadBindings: params.threadBindings
	});
	const data = await loadDiscordModelPickerData(params.cfg, route.agentId);
	const currentModel = resolveDiscordModelPickerCurrentModel({
		cfg: params.cfg,
		route,
		data
	});
	const currentRuntime = resolveDiscordModelPickerCurrentRuntime({
		cfg: params.cfg,
		route
	});
	const quickModels = await readDiscordModelPickerRecentModels({
		scope: resolveDiscordModelPickerPreferenceScope({
			interaction: params.interaction,
			accountId: params.accountId,
			userId: params.userId
		}),
		allowedModelRefs: buildDiscordModelPickerAllowedModelRefs(data),
		limit: 5
	});
	const payload = {
		...toDiscordModelPickerMessagePayload(renderDiscordModelPickerModelsView({
			command: params.command,
			userId: params.userId,
			data,
			provider: splitDiscordModelRef(currentModel ?? "")?.provider ?? data.resolvedDefault.provider,
			page: 1,
			providerPage: 1,
			currentModel,
			currentRuntime,
			quickModels
		})),
		ephemeral: true
	};
	await params.safeInteractionCall("model picker reply", async () => {
		if (params.preferFollowUp) {
			await params.interaction.followUp(payload);
			return;
		}
		await params.interaction.reply(payload);
	});
}
function splitDiscordModelRef(modelRef) {
	const trimmed = modelRef.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) return null;
	const provider = trimmed.slice(0, slashIndex).trim();
	const model = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !model) return null;
	return {
		provider,
		model
	};
}
//#endregion
//#region extensions/discord/src/monitor/native-command-model-picker-interaction.ts
function resolveModelPickerSelectionValue(interaction) {
	const rawValues = interaction.values;
	if (!Array.isArray(rawValues) || rawValues.length === 0) return null;
	const first = rawValues[0];
	if (typeof first !== "string") return null;
	return first.trim() || null;
}
function buildDiscordModelPickerSelectionCommand(params) {
	const commandDefinition = findCommandByNativeName$1("model", "discord") ?? listChatCommands().find((entry) => entry.key === "model");
	if (!commandDefinition) return null;
	const runtime = normalizeOptionalString(params.runtime);
	const raw = runtime ? `${params.modelRef} --runtime ${runtime}` : params.modelRef;
	const commandArgs = {
		values: { model: params.modelRef },
		raw
	};
	return {
		command: commandDefinition,
		args: commandArgs,
		prompt: buildCommandTextFromArgs$1(commandDefinition, commandArgs)
	};
}
function listDiscordModelPickerProviderModels(data, provider) {
	const modelSet = data.byProvider.get(provider);
	if (!modelSet) return [];
	return [...modelSet].toSorted();
}
function resolveDiscordModelPickerModelIndex(params) {
	const models = listDiscordModelPickerProviderModels(params.data, params.provider);
	if (!models.length) return null;
	const index = models.indexOf(params.model);
	if (index < 0) return null;
	return index + 1;
}
function resolveDiscordModelPickerModelByIndex(params) {
	if (!params.modelIndex || params.modelIndex < 1) return null;
	const models = listDiscordModelPickerProviderModels(params.data, params.provider);
	if (!models.length) return null;
	return models[params.modelIndex - 1] ?? null;
}
async function handleDiscordModelPickerInteraction(params) {
	const { interaction, data, ctx } = params;
	const parsed = parseDiscordModelPickerData(data);
	if (!parsed) {
		await params.safeInteractionCall("model picker update", () => interaction.update(buildDiscordModelPickerNoticePayload("Sorry, that model picker interaction is no longer available.")));
		return;
	}
	if (interaction.user?.id && interaction.user.id !== parsed.userId) {
		await params.safeInteractionCall("model picker ack", () => interaction.acknowledge());
		return;
	}
	const route = await resolveDiscordModelPickerRoute({
		interaction,
		cfg: ctx.cfg,
		accountId: ctx.accountId,
		threadBindings: ctx.threadBindings
	});
	const pickerData = await loadDiscordModelPickerData(ctx.cfg, route.agentId);
	const currentModelRef = resolveDiscordModelPickerCurrentModel({
		cfg: ctx.cfg,
		route,
		data: pickerData
	});
	const currentRuntime = resolveDiscordModelPickerCurrentRuntime({
		cfg: ctx.cfg,
		route
	});
	const allowedModelRefs = buildDiscordModelPickerAllowedModelRefs(pickerData);
	const preferenceScope = resolveDiscordModelPickerPreferenceScope({
		interaction,
		accountId: ctx.accountId,
		userId: parsed.userId
	});
	const quickModels = await readDiscordModelPickerRecentModels({
		scope: preferenceScope,
		allowedModelRefs,
		limit: 5
	});
	const updatePicker = async (payload) => await params.safeInteractionCall("model picker update", () => interaction.update(payload));
	const showNotice = async (message) => await updatePicker(buildDiscordModelPickerNoticePayload(message));
	if (parsed.action === "recents") {
		await updatePicker(toDiscordModelPickerMessagePayload(renderDiscordModelPickerRecentsView({
			command: parsed.command,
			userId: parsed.userId,
			data: pickerData,
			quickModels,
			currentModel: currentModelRef,
			provider: parsed.provider,
			page: parsed.page,
			providerPage: parsed.providerPage
		})));
		return;
	}
	if (parsed.action === "back" && parsed.view === "providers") {
		await updatePicker(toDiscordModelPickerMessagePayload(renderDiscordModelPickerProvidersView({
			command: parsed.command,
			userId: parsed.userId,
			data: pickerData,
			page: parsed.page,
			currentModel: currentModelRef
		})));
		return;
	}
	if (parsed.action === "back" && parsed.view === "models") {
		const provider = parsed.provider ?? splitDiscordModelRef(currentModelRef ?? "")?.provider ?? pickerData.resolvedDefault.provider;
		await updatePicker(toDiscordModelPickerMessagePayload(renderDiscordModelPickerModelsView({
			command: parsed.command,
			userId: parsed.userId,
			data: pickerData,
			provider,
			page: parsed.page ?? 1,
			providerPage: parsed.providerPage ?? 1,
			currentModel: currentModelRef,
			currentRuntime,
			quickModels
		})));
		return;
	}
	if (parsed.action === "provider") {
		const selectedProvider = resolveModelPickerSelectionValue(interaction) ?? parsed.provider;
		if (!selectedProvider || !pickerData.byProvider.has(selectedProvider)) {
			await showNotice("Sorry, that provider isn't available anymore.");
			return;
		}
		await updatePicker(toDiscordModelPickerMessagePayload(renderDiscordModelPickerModelsView({
			command: parsed.command,
			userId: parsed.userId,
			data: pickerData,
			provider: selectedProvider,
			page: 1,
			providerPage: parsed.providerPage ?? parsed.page,
			currentModel: currentModelRef,
			currentRuntime,
			quickModels
		})));
		return;
	}
	if (parsed.action === "model") {
		const selectedModel = resolveModelPickerSelectionValue(interaction);
		const provider = parsed.provider;
		if (!provider || !selectedModel) {
			await showNotice("Sorry, I couldn't read that model selection.");
			return;
		}
		const modelIndex = resolveDiscordModelPickerModelIndex({
			data: pickerData,
			provider,
			model: selectedModel
		});
		if (!modelIndex) {
			await showNotice("Sorry, that model isn't available anymore.");
			return;
		}
		const modelRef = `${provider}/${selectedModel}`;
		await updatePicker(toDiscordModelPickerMessagePayload(renderDiscordModelPickerModelsView({
			command: parsed.command,
			userId: parsed.userId,
			data: pickerData,
			provider,
			page: parsed.page,
			providerPage: parsed.providerPage ?? 1,
			currentModel: currentModelRef,
			currentRuntime,
			pendingModel: modelRef,
			pendingModelIndex: modelIndex,
			pendingRuntime: parsed.runtime,
			quickModels
		})));
		return;
	}
	if (parsed.action === "runtime") {
		const selectedRuntime = resolveModelPickerSelectionValue(interaction) ?? parsed.runtime ?? "auto";
		const provider = parsed.provider;
		if (!provider || !pickerData.byProvider.has(provider)) {
			await showNotice("Sorry, that provider isn't available anymore.");
			return;
		}
		const selectedModel = resolveDiscordModelPickerModelByIndex({
			data: pickerData,
			provider,
			modelIndex: parsed.modelIndex
		});
		const pendingModel = selectedModel ? `${provider}/${selectedModel}` : void 0;
		await updatePicker(toDiscordModelPickerMessagePayload(renderDiscordModelPickerModelsView({
			command: parsed.command,
			userId: parsed.userId,
			data: pickerData,
			provider,
			page: parsed.page,
			providerPage: parsed.providerPage ?? 1,
			currentModel: currentModelRef,
			currentRuntime,
			...pendingModel ? { pendingModel } : {},
			pendingModelIndex: parsed.modelIndex,
			pendingRuntime: selectedRuntime,
			quickModels
		})));
		return;
	}
	if (parsed.action === "submit" || parsed.action === "reset" || parsed.action === "quick") {
		let modelRef = null;
		if (parsed.action === "reset") modelRef = `${pickerData.resolvedDefault.provider}/${pickerData.resolvedDefault.model}`;
		else if (parsed.action === "quick") {
			const slot = parsed.recentSlot ?? 0;
			modelRef = slot >= 1 ? quickModels[slot - 1] ?? null : null;
		} else if (parsed.view === "recents") {
			const defaultModelRef = `${pickerData.resolvedDefault.provider}/${pickerData.resolvedDefault.model}`;
			const dedupedRecents = quickModels.filter((ref) => ref !== defaultModelRef);
			const slot = parsed.recentSlot ?? 0;
			if (slot === 1) modelRef = defaultModelRef;
			else if (slot >= 2) modelRef = dedupedRecents[slot - 2] ?? null;
		} else {
			const provider = parsed.provider;
			const selectedModel = resolveDiscordModelPickerModelByIndex({
				data: pickerData,
				provider: provider ?? "",
				modelIndex: parsed.modelIndex
			});
			modelRef = provider && selectedModel ? `${provider}/${selectedModel}` : null;
		}
		const parsedModelRef = modelRef ? splitDiscordModelRef(modelRef) : null;
		if (!parsedModelRef || !pickerData.byProvider.get(parsedModelRef.provider)?.has(parsedModelRef.model)) {
			await showNotice("That selection expired. Please choose a model again.");
			return;
		}
		const resolvedModelRef = `${parsedModelRef.provider}/${parsedModelRef.model}`;
		const selectionCommand = buildDiscordModelPickerSelectionCommand({
			modelRef: resolvedModelRef,
			runtime: normalizeOptionalString(parsed.runtime) ?? (currentRuntime !== "auto" && currentRuntime !== "default" ? currentRuntime : void 0)
		});
		if (!selectionCommand) {
			await showNotice("Sorry, /model is unavailable right now.");
			return;
		}
		if (await showNotice(`Applying model change to ${resolvedModelRef}...`) === null) return;
		const applyResult = await applyDiscordModelPickerSelection({
			interaction,
			selectionCommand,
			dispatchCommandInteraction: params.dispatchCommandInteraction,
			cfg: ctx.cfg,
			discordConfig: ctx.discordConfig,
			accountId: ctx.accountId,
			sessionPrefix: ctx.sessionPrefix,
			threadBindings: ctx.threadBindings,
			route,
			resolvedModelRef,
			selectedProvider: parsedModelRef.provider,
			selectedModel: parsedModelRef.model,
			defaultProvider: pickerData.resolvedDefault.provider,
			defaultModel: pickerData.resolvedDefault.model,
			preferenceScope,
			settleMs: ctx.postApplySettleMs ?? 250,
			resolveCurrentModel: (currentRoute) => resolveDiscordModelPickerCurrentModel({
				cfg: ctx.cfg,
				route: currentRoute,
				data: pickerData
			})
		});
		await params.safeInteractionCall("model picker follow-up", () => interaction.followUp({
			...buildDiscordModelPickerNoticePayload(applyResult.noticeMessage),
			ephemeral: true
		}));
		return;
	}
	if (parsed.action === "cancel") await showNotice(`ℹ️ Model kept as ${currentModelRef ?? "default"}.`);
}
async function runDiscordModelPickerFallback(params) {
	await handleDiscordModelPickerInteraction(params);
}
var DiscordModelPickerFallbackButton = class extends Button {
	constructor(params) {
		super();
		this.params = params;
		this.label = "modelpick";
		this.customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=btn`;
	}
	async run(interaction, data) {
		await runDiscordModelPickerFallback({
			...this.params,
			interaction,
			data
		});
	}
};
var DiscordModelPickerFallbackSelect = class extends StringSelectMenu {
	constructor(params) {
		super();
		this.params = params;
		this.customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=sel`;
		this.options = [];
	}
	async run(interaction, data) {
		await runDiscordModelPickerFallback({
			...this.params,
			interaction,
			data
		});
	}
};
function createDiscordModelPickerFallbackButton$1(params) {
	return new DiscordModelPickerFallbackButton(params);
}
function createDiscordModelPickerFallbackSelect$1(params) {
	return new DiscordModelPickerFallbackSelect(params);
}
//#endregion
//#region extensions/discord/src/monitor/native-command.args.ts
function readDiscordCommandArgs(interaction, definitions) {
	if (!definitions || definitions.length === 0) return;
	const values = {};
	for (const definition of definitions) {
		let value;
		if (definition.type === "number") value = interaction.options.getNumber(definition.name) ?? null;
		else if (definition.type === "boolean") value = interaction.options.getBoolean(definition.name) ?? null;
		else value = interaction.options.getString(definition.name) ?? null;
		if (value != null) values[definition.name] = value;
	}
	return Object.keys(values).length > 0 ? { values } : void 0;
}
function createNativeCommandDefinition(command) {
	return {
		key: command.name,
		nativeName: command.name,
		description: command.description,
		textAliases: [],
		acceptsArgs: command.acceptsArgs,
		args: command.args,
		argsParsing: "none",
		scope: "native"
	};
}
//#endregion
//#region extensions/discord/src/monitor/native-command.options.ts
const log$1 = createSubsystemLogger("discord/native-command");
const DISCORD_COMMAND_DESCRIPTION_MAX = 100;
function truncateDiscordCommandDescription(params) {
	const { value, label } = params;
	if (value.length <= DISCORD_COMMAND_DESCRIPTION_MAX) return value;
	log$1.warn(`discord: truncating native command description (${label}) from ${value.length} to ${DISCORD_COMMAND_DESCRIPTION_MAX}: ${JSON.stringify(value)}`);
	return value.slice(0, DISCORD_COMMAND_DESCRIPTION_MAX);
}
function truncateDiscordCommandDescriptionLocalizations(params) {
	const entries = Object.entries(params.value ?? {});
	if (entries.length === 0) return;
	return Object.fromEntries(entries.map(([locale, description]) => [locale, truncateDiscordCommandDescription({
		value: description,
		label: `${params.label} locale:${locale}`
	})]));
}
function resolveDiscordCommandLogLabel(command) {
	if (typeof command.nativeName === "string" && command.nativeName.trim().length > 0) return command.nativeName;
	return command.key;
}
function buildDiscordCommandOptions(params) {
	const { command, cfg, authorizeChoiceContext, resolveChoiceContext } = params;
	const commandLabel = resolveDiscordCommandLogLabel(command);
	const args = command.args;
	if (!args || args.length === 0) return;
	return args.map((arg) => {
		const required = arg.required ?? false;
		if (arg.type === "number") return {
			name: arg.name,
			description: truncateDiscordCommandDescription({
				value: arg.description,
				label: `command:${commandLabel} arg:${arg.name}`
			}),
			type: ApplicationCommandOptionType.Number,
			required
		};
		if (arg.type === "boolean") return {
			name: arg.name,
			description: truncateDiscordCommandDescription({
				value: arg.description,
				label: `command:${commandLabel} arg:${arg.name}`
			}),
			type: ApplicationCommandOptionType.Boolean,
			required
		};
		const resolvedChoices = resolveCommandArgChoices({
			command,
			arg,
			cfg
		});
		const autocomplete = arg.preferAutocomplete === true || resolvedChoices.length > 0 && (typeof arg.choices === "function" || resolvedChoices.length > 25) ? async (interaction) => {
			if (typeof arg.choices === "function" && resolveChoiceContext && authorizeChoiceContext && !await authorizeChoiceContext(interaction)) {
				await interaction.respond([]);
				return;
			}
			const focusValue = normalizeLowercaseStringOrEmpty(interaction.options.getFocused()?.value);
			const context = typeof arg.choices === "function" && resolveChoiceContext ? await resolveChoiceContext(interaction) : null;
			const choices = resolveCommandArgChoices({
				command,
				arg,
				cfg,
				provider: context?.provider,
				model: context?.model
			});
			const filtered = focusValue ? choices.filter((choice) => normalizeLowercaseStringOrEmpty(choice.label).includes(focusValue)) : choices;
			await interaction.respond(filtered.slice(0, 25).map((choice) => ({
				name: choice.label,
				value: choice.value
			})));
		} : void 0;
		const choices = resolvedChoices.length > 0 && !autocomplete ? resolvedChoices.slice(0, 25).map((choice) => ({
			name: choice.label,
			value: choice.value
		})) : void 0;
		return {
			name: arg.name,
			description: truncateDiscordCommandDescription({
				value: arg.description,
				label: `command:${commandLabel} arg:${arg.name}`
			}),
			type: ApplicationCommandOptionType.String,
			required,
			choices,
			autocomplete
		};
	});
}
//#endregion
//#region extensions/discord/src/monitor/native-command.ts
const log = createSubsystemLogger("discord/native-command");
function createDiscordNativeCommand(params) {
	const { command, cfg, discordConfig, accountId, sessionPrefix, ephemeralDefault, threadBindings } = params;
	const fallbackCommandDefinition = createNativeCommandDefinition(command);
	const commandDefinition = nativeCommandRuntime.matchPluginCommand(`/${command.name}`) !== null ? fallbackCommandDefinition : findCommandByNativeName(command.name, "discord", { includeBundledChannelFallback: false }) ?? fallbackCommandDefinition;
	const argDefinitions = commandDefinition.args ?? command.args;
	const commandOptions = buildDiscordCommandOptions({
		command: commandDefinition,
		cfg,
		authorizeChoiceContext: async (interaction) => await resolveDiscordNativeAutocompleteAuthorized({
			interaction,
			cfg,
			discordConfig,
			accountId
		}),
		resolveChoiceContext: async (interaction) => resolveDiscordNativeChoiceContext({
			interaction,
			cfg,
			accountId,
			threadBindings
		})
	});
	const options = commandOptions ? commandOptions : command.acceptsArgs ? [{
		name: "input",
		description: "Command input",
		type: ApplicationCommandOptionType.String,
		required: false
	}] : void 0;
	return new class extends Command {
		constructor(..._args) {
			super(..._args);
			this.name = command.name;
			this.description = truncateDiscordCommandDescription({
				value: command.description,
				label: `command:${command.name}`
			});
			this.descriptionLocalizations = truncateDiscordCommandDescriptionLocalizations({
				value: command.descriptionLocalizations,
				label: `command:${command.name}`
			});
			this.defer = false;
			this.ephemeral = ephemeralDefault;
			this.options = options;
		}
		async run(interaction) {
			if (await safeDiscordInteractionCall("interaction defer", () => interaction.defer({ ephemeral: this.ephemeral })) === null) return;
			const commandArgs = argDefinitions?.length ? readDiscordCommandArgs(interaction, argDefinitions) : command.acceptsArgs ? parseCommandArgs(commandDefinition, interaction.options.getString("input") ?? "") : void 0;
			const commandArgsWithRaw = commandArgs ? {
				...commandArgs,
				raw: serializeCommandArgs(commandDefinition, commandArgs) ?? commandArgs.raw
			} : void 0;
			await dispatchDiscordCommandInteraction({
				interaction,
				prompt: buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw),
				command: commandDefinition,
				commandArgs: commandArgsWithRaw,
				cfg,
				discordConfig,
				accountId,
				sessionPrefix,
				preferFollowUp: true,
				threadBindings,
				responseEphemeral: ephemeralDefault
			});
		}
	}();
}
async function dispatchDiscordCommandInteraction(params) {
	const { interaction, prompt, command, commandArgs, cfg, discordConfig, accountId, sessionPrefix, preferFollowUp, threadBindings, responseEphemeral, suppressReplies } = params;
	const commandName = command.nativeName ?? command.key;
	const respond = async (content, options) => {
		const ephemeral = options?.ephemeral ?? responseEphemeral;
		const payload = {
			content,
			...ephemeral !== void 0 ? { ephemeral } : {}
		};
		await safeDiscordInteractionCall("interaction reply", async () => {
			if (preferFollowUp) {
				await interaction.followUp(payload);
				return;
			}
			await interaction.reply(payload);
		});
	};
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const user = interaction.user;
	if (!user) return { accepted: false };
	const sender = resolveDiscordSenderIdentity({
		author: user,
		pluralkitInfo: null
	});
	const channel = interaction.channel;
	const { isDirectMessage, isGroupDm, isThreadChannel, channelName, channelSlug, rawChannelId, threadParentId, threadParentName, threadParentSlug } = await resolveDiscordNativeInteractionChannelContext({
		channel,
		client: interaction.client,
		hasGuild: Boolean(interaction.guild),
		channelIdFallback: ""
	});
	const memberRoleIds = Array.isArray(interaction.rawData.member?.roles) ? interaction.rawData.member.roles.map((roleId) => roleId) : [];
	const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
	const configuredDmAllowFrom = resolveDiscordAccountAllowFrom({
		cfg,
		accountId
	}) ?? [];
	const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
		allowFrom: configuredDmAllowFrom,
		sender: {
			id: sender.id,
			name: sender.name,
			tag: sender.tag
		},
		allowNameMatching
	});
	const commandsAllowFromAccess = resolveDiscordNativeCommandAllowlistAccess({
		cfg,
		accountId,
		sender: {
			id: sender.id,
			name: sender.name,
			tag: sender.tag
		},
		chatType: isDirectMessage ? "direct" : isThreadChannel ? "thread" : interaction.guild ? "channel" : "group",
		conversationId: rawChannelId || void 0,
		guildId: interaction.guild?.id
	});
	const guildInfo = resolveDiscordGuildEntry({
		guild: interaction.guild ?? void 0,
		guildId: interaction.guild?.id ?? void 0,
		guildEntries: discordConfig?.guilds
	});
	const channelConfig = interaction.guild ? resolveDiscordChannelConfigWithFallback({
		guildInfo,
		channelId: rawChannelId,
		channelName,
		channelSlug,
		parentId: threadParentId,
		parentName: threadParentName,
		parentSlug: threadParentSlug,
		scope: isThreadChannel ? "thread" : "channel"
	}) : null;
	let nativeRouteStatePromise;
	const getNativeRouteState = () => nativeRouteStatePromise ??= nativeCommandRuntime.resolveDiscordNativeInteractionRouteState({
		cfg,
		accountId,
		guildId: interaction.guild?.id ?? void 0,
		memberRoleIds,
		isDirectMessage,
		isGroupDm,
		directUserId: user.id,
		conversationId: rawChannelId || "unknown",
		parentConversationId: threadParentId,
		threadBinding: isThreadChannel ? threadBindings.getByThreadId(rawChannelId) : void 0,
		enforceConfiguredBindingReadiness: !shouldBypassConfiguredAcpEnsure(commandName)
	});
	const canBypassConfiguredAcpGuildGuards = async () => {
		if (!interaction.guild || !shouldBypassConfiguredAcpGuildGuards(commandName)) return false;
		const routeState = await getNativeRouteState();
		return routeState.effectiveRoute.matchedBy === "binding.channel" || routeState.boundSessionKey != null || routeState.configuredBinding != null || routeState.configuredRoute != null;
	};
	if (channelConfig?.enabled === false && !await canBypassConfiguredAcpGuildGuards()) {
		await respond("This channel is disabled.");
		return { accepted: false };
	}
	if (interaction.guild && channelConfig?.allowed === false && !await canBypassConfiguredAcpGuildGuards()) {
		await respond("This channel is not allowed.");
		return { accepted: false };
	}
	if (useAccessGroups && interaction.guild) {
		const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
			providerConfigPresent: cfg.channels?.discord !== void 0,
			groupPolicy: discordConfig?.groupPolicy,
			defaultGroupPolicy: cfg.channels?.defaults?.groupPolicy
		});
		if (!resolveDiscordChannelPolicyCommandAuthorizer({
			groupPolicy,
			guildInfo,
			channelConfig
		}).allowed && !await canBypassConfiguredAcpGuildGuards()) {
			await respond("This channel is not allowed.");
			return { accepted: false };
		}
	}
	const dmEnabled = discordConfig?.dm?.enabled ?? true;
	const dmPolicy = resolveDiscordAccountDmPolicy({
		cfg,
		accountId
	}) ?? "pairing";
	let commandAuthorized = true;
	if (isDirectMessage) {
		if (!dmEnabled || dmPolicy === "disabled") {
			await respond("Discord DMs are disabled.");
			return { accepted: false };
		}
		const dmAccess = await resolveDiscordDmCommandAccess({
			accountId,
			dmPolicy,
			configuredAllowFrom: configuredDmAllowFrom,
			sender: {
				id: sender.id,
				name: sender.name,
				tag: sender.tag
			},
			allowNameMatching,
			useAccessGroups,
			cfg,
			rest: interaction.client.rest
		});
		commandAuthorized = dmAccess.commandAuthorized;
		if (dmAccess.decision !== "allow") {
			await handleDiscordDmCommandDecision({
				dmAccess,
				accountId,
				sender: {
					id: user.id,
					tag: sender.tag,
					name: sender.name
				},
				onPairingCreated: async (code) => {
					await respond(buildPairingReply({
						channel: "discord",
						idLine: `Your Discord user id: ${user.id}`,
						code
					}), { ephemeral: true });
				},
				onUnauthorized: async () => {
					await respond("You are not authorized to use this command.", { ephemeral: true });
				}
			});
			return { accepted: false };
		}
	}
	const groupDmAccess = resolveDiscordNativeGroupDmAccess({
		isGroupDm,
		groupEnabled: discordConfig?.dm?.groupEnabled,
		groupChannels: discordConfig?.dm?.groupChannels,
		channelId: rawChannelId,
		channelName,
		channelSlug
	});
	if (!groupDmAccess.allowed) {
		await respond(groupDmAccess.reason === "disabled" ? "Discord group DMs are disabled." : "This group DM is not allowed.");
		return { accepted: false };
	}
	if (!isDirectMessage) {
		commandAuthorized = resolveDiscordGuildNativeCommandAuthorized({
			cfg,
			discordConfig,
			useAccessGroups,
			commandsAllowFromAccess,
			guildInfo,
			channelConfig,
			memberRoleIds,
			sender,
			allowNameMatching,
			ownerAllowListConfigured: ownerAllowList != null,
			ownerAllowed: ownerOk
		});
		if (!commandAuthorized && !await canBypassConfiguredAcpGuildGuards()) {
			await respond("You are not authorized to use this command.", { ephemeral: true });
			return { accepted: false };
		}
	}
	const menuModelContext = !(commandArgs?.raw && !commandArgs.values) && command.args?.some((arg) => typeof arg.choices === "function" && commandArgs?.values?.[arg.name] == null) ? await resolveDiscordNativeChoiceContext({
		interaction,
		cfg,
		accountId,
		threadBindings
	}) : null;
	const menu = resolveCommandArgMenu({
		command,
		args: commandArgs,
		cfg,
		provider: menuModelContext?.provider,
		model: menuModelContext?.model
	});
	if (menu) {
		const menuPayload = buildDiscordCommandArgMenu({
			command,
			menu,
			interaction,
			ctx: {
				cfg,
				discordConfig,
				accountId,
				sessionPrefix,
				threadBindings
			},
			safeInteractionCall: safeDiscordInteractionCall,
			dispatchCommandInteraction: dispatchDiscordCommandInteraction
		});
		if (preferFollowUp) {
			await safeDiscordInteractionCall("interaction follow-up", () => interaction.followUp({
				content: menuPayload.content,
				components: menuPayload.components,
				ephemeral: true
			}));
			return { accepted: true };
		}
		await safeDiscordInteractionCall("interaction reply", () => interaction.reply({
			content: menuPayload.content,
			components: menuPayload.components,
			ephemeral: true
		}));
		return { accepted: true };
	}
	const pluginMatch = nativeCommandRuntime.matchPluginCommand(prompt);
	if (pluginMatch && commandName !== "status") {
		if (suppressReplies) return { accepted: true };
		const channelId = rawChannelId || "unknown";
		const messageThreadId = !isDirectMessage && isThreadChannel ? channelId : void 0;
		const pluginThreadParentId = !isDirectMessage && isThreadChannel ? threadParentId : void 0;
		const { effectiveRoute } = await getNativeRouteState();
		const pluginReply = await nativeCommandRuntime.executePluginCommand({
			command: pluginMatch.command,
			args: pluginMatch.args,
			senderId: sender.id,
			channel: "discord",
			channelId,
			isAuthorizedSender: commandAuthorized,
			sessionKey: effectiveRoute.sessionKey,
			commandBody: prompt,
			config: cfg,
			from: isDirectMessage ? `discord:${user.id}` : isGroupDm ? `discord:group:${channelId}` : `discord:channel:${channelId}`,
			to: `slash:${user.id}`,
			accountId,
			messageThreadId,
			threadParentId: pluginThreadParentId
		});
		if (!hasRenderableReplyPayload(pluginReply)) {
			await respond(DISCORD_EMPTY_VISIBLE_REPLY_WARNING);
			return {
				accepted: true,
				effectiveRoute
			};
		}
		await deliverDiscordInteractionReply({
			interaction,
			payload: pluginReply,
			textLimit: resolveTextChunkLimit(cfg, "discord", accountId, { fallbackLimit: 2e3 }),
			maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
				cfg,
				discordConfig,
				accountId
			}),
			preferFollowUp,
			responseEphemeral,
			chunkMode: resolveChunkMode(cfg, "discord", accountId)
		});
		return {
			accepted: true,
			effectiveRoute
		};
	}
	const pickerCommandContext = shouldOpenDiscordModelPickerFromCommand({
		command,
		commandArgs
	});
	if (pickerCommandContext) {
		await replyWithDiscordModelPickerProviders({
			interaction,
			cfg,
			command: pickerCommandContext,
			userId: user.id,
			accountId,
			threadBindings,
			preferFollowUp,
			safeInteractionCall: safeDiscordInteractionCall
		});
		return { accepted: true };
	}
	const isGuild = Boolean(interaction.guild);
	const channelId = rawChannelId || "unknown";
	const interactionId = interaction.rawData.id;
	const routeState = await getNativeRouteState();
	if (routeState.bindingReadiness && !routeState.bindingReadiness.ok) {
		const configuredBinding = routeState.configuredBinding;
		if (configuredBinding) {
			logVerbose(`discord native command: configured ACP binding unavailable for channel ${configuredBinding.record.conversation.conversationId}: ${routeState.bindingReadiness.error}`);
			await respond("Configured ACP binding is unavailable right now. Please try again.");
			return { accepted: false };
		}
	}
	const boundSessionKey = routeState.boundSessionKey;
	const effectiveRoute = routeState.effectiveRoute;
	const { sessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
		agentId: effectiveRoute.agentId,
		sessionPrefix,
		userId: user.id,
		targetSessionKey: effectiveRoute.sessionKey,
		boundSessionKey
	});
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, effectiveRoute.agentId);
	const directStatusResult = await maybeDeliverDiscordDirectStatus({
		commandName,
		suppressReplies,
		resolveDirectStatusReplyForSession: nativeCommandRuntime.resolveDirectStatusReplyForSession,
		cfg,
		discordConfig,
		accountId,
		sessionKey,
		commandTargetSessionKey,
		channel: "discord",
		senderId: sender.id,
		senderIsOwner: ownerOk,
		isAuthorizedSender: commandAuthorized,
		isGroup: isGuild || isGroupDm,
		defaultGroupActivation: () => !isGuild ? "always" : channelConfig?.requireMention === false ? "always" : "mention",
		interaction,
		mediaLocalRoots,
		preferFollowUp,
		responseEphemeral,
		effectiveRoute,
		respond
	});
	if (directStatusResult) return directStatusResult;
	await dispatchDiscordNativeAgentReply({
		cfg,
		discordConfig,
		accountId,
		interaction,
		ctxPayload: buildDiscordNativeCommandContext({
			prompt,
			commandArgs: commandArgs ?? {},
			sessionKey,
			commandTargetSessionKey,
			accountId: effectiveRoute.accountId,
			interactionId,
			channelId,
			threadParentId,
			memberRoleIds,
			guildId: interaction.guild?.id,
			guildName: interaction.guild?.name,
			channelTopic: resolveDiscordChannelTopicSafe(channel),
			channelConfig,
			guildInfo,
			allowNameMatching,
			commandAuthorized,
			isDirectMessage,
			isGroupDm,
			isGuild,
			isThreadChannel,
			user: {
				id: user.id,
				username: user.username,
				globalName: user.globalName
			},
			sender: {
				id: sender.id,
				name: sender.name,
				tag: sender.tag
			}
		}),
		effectiveRoute,
		channelConfig,
		mediaLocalRoots,
		preferFollowUp,
		responseEphemeral,
		suppressReplies,
		log
	});
	return {
		accepted: true,
		effectiveRoute
	};
}
function createDiscordCommandArgFallbackButton(params) {
	return createDiscordCommandArgFallbackButton$1({
		ctx: params,
		safeInteractionCall: safeDiscordInteractionCall,
		dispatchCommandInteraction: dispatchDiscordCommandInteraction
	});
}
function createDiscordModelPickerFallbackButton(params) {
	return createDiscordModelPickerFallbackButton$1({
		ctx: params,
		safeInteractionCall: safeDiscordInteractionCall,
		dispatchCommandInteraction: dispatchDiscordCommandInteraction
	});
}
function createDiscordModelPickerFallbackSelect(params) {
	return createDiscordModelPickerFallbackSelect$1({
		ctx: params,
		safeInteractionCall: safeDiscordInteractionCall,
		dispatchCommandInteraction: dispatchDiscordCommandInteraction
	});
}
//#endregion
//#region extensions/discord/src/internal/gateway-close-codes.ts
const fatalGatewayCloseCodes = new Set([
	GatewayCloseCodes.AuthenticationFailed,
	GatewayCloseCodes.InvalidShard,
	GatewayCloseCodes.ShardingRequired,
	GatewayCloseCodes.InvalidAPIVersion,
	GatewayCloseCodes.InvalidIntents,
	GatewayCloseCodes.DisallowedIntents
]);
const nonResumableGatewayCloseCodes = new Set([
	GatewayCloseCodes.NotAuthenticated,
	GatewayCloseCodes.InvalidSeq,
	GatewayCloseCodes.SessionTimedOut,
	GatewayCloseCodes.AlreadyAuthenticated
]);
function isFatalGatewayCloseCode(code) {
	return fatalGatewayCloseCodes.has(code);
}
function canResumeAfterGatewayClose(code) {
	return !nonResumableGatewayCloseCodes.has(code);
}
//#endregion
//#region extensions/discord/src/internal/gateway-dispatch.ts
function dispatchVoiceGatewayEvent(client, type, data) {
	const guildId = readGuildId(data);
	if (!guildId) return;
	const adapter = (client.getPlugin("voice")?.adapters)?.get(guildId);
	const voiceServerUpdate = GatewayDispatchEvents.VoiceServerUpdate;
	const voiceStateUpdate = GatewayDispatchEvents.VoiceStateUpdate;
	if (type === voiceServerUpdate) adapter?.onVoiceServerUpdate?.(data);
	if (type === voiceStateUpdate) adapter?.onVoiceStateUpdate?.(data);
}
function mapGatewayDispatchData(client, type, data) {
	const messageCreate = GatewayDispatchEvents.MessageCreate;
	const reactionAdd = GatewayDispatchEvents.MessageReactionAdd;
	const reactionRemove = GatewayDispatchEvents.MessageReactionRemove;
	if (type === messageCreate) return createMessageDispatchData(client, data);
	if (type === reactionAdd || type === reactionRemove) return createReactionDispatchData(client, data);
	return data;
}
function createMessageDispatchData(client, data) {
	const message = new Message(client, data);
	return {
		...data,
		id: data.id,
		channel_id: data.channel_id,
		channelId: data.channel_id,
		message,
		author: message.author ?? (data.author ? new User(client, data.author) : null),
		member: data.member,
		rawMember: data.member,
		guild: data.guild_id ? new Guild(client, data.guild_id) : null
	};
}
function createReactionDispatchData(client, data) {
	const userRaw = data.member?.user && typeof data.member.user === "object" ? {
		id: data.user_id,
		username: "",
		...data.member.user
	} : {
		id: data.user_id,
		username: ""
	};
	return {
		...data,
		user: new User(client, userRaw),
		rawMember: data.member,
		guild: data.guild_id ? new Guild(client, data.guild_id) : null,
		message: new Message(client, {
			id: data.message_id,
			channelId: data.channel_id
		})
	};
}
function readGuildId(data) {
	return data && typeof data === "object" && typeof data.guild_id === "string" ? data.guild_id : void 0;
}
//#endregion
//#region extensions/discord/src/internal/gateway-identify-limiter.ts
const IDENTIFY_WINDOW_MS = 5e3;
var GatewayIdentifyLimiter = class {
	constructor() {
		this.nextAllowedAtByKey = /* @__PURE__ */ new Map();
	}
	async wait(params) {
		const maxConcurrency = Math.max(1, Math.floor(params.maxConcurrency ?? 1));
		const rateKey = (params.shardId ?? 0) % maxConcurrency;
		const now = Date.now();
		const nextAllowedAt = this.nextAllowedAtByKey.get(rateKey) ?? now;
		const waitMs = Math.max(0, nextAllowedAt - now);
		this.nextAllowedAtByKey.set(rateKey, Math.max(now, nextAllowedAt) + IDENTIFY_WINDOW_MS);
		if (waitMs > 0) await new Promise((resolve) => {
			setTimeout(resolve, waitMs).unref?.();
		});
	}
	reset() {
		this.nextAllowedAtByKey.clear();
	}
};
const sharedGatewayIdentifyLimiter = new GatewayIdentifyLimiter();
//#endregion
//#region extensions/discord/src/internal/gateway-lifecycle.ts
var GatewayHeartbeatTimers = class {
	start(params) {
		this.stop();
		const random = params.random ?? Math.random;
		this.firstHeartbeatTimeout = setTimeout(params.onHeartbeat, Math.max(0, params.intervalMs * random()));
		this.firstHeartbeatTimeout.unref?.();
		this.heartbeatInterval = setInterval(() => {
			if (!params.isAcked()) {
				params.onAckTimeout();
				return;
			}
			params.onHeartbeat();
		}, params.intervalMs);
		this.heartbeatInterval.unref?.();
	}
	stop() {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = void 0;
		}
		if (this.firstHeartbeatTimeout) {
			clearTimeout(this.firstHeartbeatTimeout);
			this.firstHeartbeatTimeout = void 0;
		}
	}
};
var GatewayReconnectTimer = class {
	stop() {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = void 0;
		}
	}
	schedule(delayMs, callback) {
		this.stop();
		this.timeout = setTimeout(() => {
			this.timeout = void 0;
			callback();
		}, delayMs);
		this.timeout.unref?.();
	}
};
//#endregion
//#region extensions/discord/src/internal/gateway-rate-limit.ts
const GATEWAY_SEND_LIMIT = 120;
const GATEWAY_SEND_WINDOW_MS = 6e4;
var GatewaySendLimiter = class {
	constructor(sendNow, emitError) {
		this.sendNow = sendNow;
		this.emitError = emitError;
		this.outboundSendTimestamps = [];
		this.outboundQueue = [];
	}
	send(serialized, options) {
		if (options?.critical || this.canSend(Date.now())) {
			this.sendSerialized(serialized);
			return;
		}
		this.outboundQueue.push({ payload: serialized });
		this.scheduleFlush();
	}
	clear() {
		if (this.outboundFlushTimer) {
			clearTimeout(this.outboundFlushTimer);
			this.outboundFlushTimer = void 0;
		}
		this.outboundQueue = [];
	}
	getStatus() {
		const now = Date.now();
		this.pruneWindow(now);
		const oldest = this.outboundSendTimestamps[0] ?? now;
		return {
			remainingEvents: Math.max(0, GATEWAY_SEND_LIMIT - this.outboundSendTimestamps.length),
			resetTime: this.outboundSendTimestamps.length > 0 ? oldest + GATEWAY_SEND_WINDOW_MS : now + GATEWAY_SEND_WINDOW_MS,
			currentEventCount: this.outboundSendTimestamps.length,
			queuedEvents: this.outboundQueue.length
		};
	}
	pruneWindow(now) {
		const windowStart = now - GATEWAY_SEND_WINDOW_MS;
		while (this.outboundSendTimestamps.length > 0 && (this.outboundSendTimestamps[0] ?? 0) <= windowStart) this.outboundSendTimestamps.shift();
	}
	canSend(now) {
		this.pruneWindow(now);
		return this.outboundSendTimestamps.length < GATEWAY_SEND_LIMIT;
	}
	sendSerialized(serialized) {
		this.outboundSendTimestamps.push(Date.now());
		this.sendNow(serialized);
	}
	scheduleFlush() {
		if (this.outboundFlushTimer || this.outboundQueue.length === 0) return;
		const now = Date.now();
		this.pruneWindow(now);
		const oldest = this.outboundSendTimestamps[0] ?? now;
		const delayMs = this.outboundSendTimestamps.length >= GATEWAY_SEND_LIMIT ? Math.max(0, oldest + GATEWAY_SEND_WINDOW_MS - now) : 0;
		this.outboundFlushTimer = setTimeout(() => {
			this.outboundFlushTimer = void 0;
			this.flush();
		}, delayMs);
		this.outboundFlushTimer.unref?.();
	}
	flush() {
		while (this.outboundQueue.length > 0 && this.canSend(Date.now())) {
			const queued = this.outboundQueue.shift();
			if (!queued) continue;
			try {
				this.sendSerialized(queued.payload);
			} catch (error) {
				this.emitError(error instanceof Error ? error : new Error(String(error), { cause: error }));
				this.clear();
				return;
			}
		}
		this.scheduleFlush();
	}
};
//#endregion
//#region extensions/discord/src/internal/gateway.ts
const GatewayIntents = GatewayIntentBits;
const READY_STATE_OPEN = 1;
const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/";
const DISCORD_GATEWAY_PAYLOAD_LIMIT_BYTES = 4096;
const INVALID_SESSION_MIN_DELAY_MS = 1e3;
const INVALID_SESSION_JITTER_MS = 4e3;
function ensureGatewayParams(url) {
	const parsed = new URL(url);
	parsed.searchParams.set("v", parsed.searchParams.get("v") ?? "10");
	parsed.searchParams.set("encoding", parsed.searchParams.get("encoding") ?? "json");
	return parsed.toString();
}
function decodeGatewayMessage(incoming) {
	const text = Buffer.isBuffer(incoming) ? incoming.toString("utf8") : incoming instanceof ArrayBuffer ? Buffer.from(incoming).toString("utf8") : Array.isArray(incoming) ? Buffer.concat(incoming.map((entry) => Buffer.from(entry))).toString("utf8") : String(incoming);
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
var GatewayPlugin = class extends Plugin {
	constructor(options, gatewayInfo) {
		super();
		this.id = "gateway";
		this.ws = null;
		this.sequence = null;
		this.lastHeartbeatAck = true;
		this.emitter = new EventEmitter();
		this.isConnected = false;
		this.sessionId = null;
		this.resumeGatewayUrl = null;
		this.reconnectAttempts = 0;
		this.shouldReconnect = false;
		this.isConnecting = false;
		this.heartbeatTimers = new GatewayHeartbeatTimers();
		this.reconnectTimer = new GatewayReconnectTimer();
		this.outboundLimiter = new GatewaySendLimiter((payload) => this.sendSerializedGatewayEvent(payload), (error) => this.emitter.emit("error", error));
		this.options = {
			...options,
			reconnect: {
				maxAttempts: 50,
				...options.reconnect
			},
			autoInteractions: options.autoInteractions ?? true,
			intents: options.intents ?? 0
		};
		this.gatewayInfo = gatewayInfo;
	}
	get ping() {
		return null;
	}
	get heartbeatInterval() {
		return this.heartbeatTimers.heartbeatInterval;
	}
	set heartbeatInterval(timer) {
		this.heartbeatTimers.heartbeatInterval = timer;
	}
	get firstHeartbeatTimeout() {
		return this.heartbeatTimers.firstHeartbeatTimeout;
	}
	set firstHeartbeatTimeout(timer) {
		this.heartbeatTimers.firstHeartbeatTimeout = timer;
	}
	async registerClient(client) {
		this.client = client;
		if (this.options.shard) {
			client.shardId = this.options.shard[0];
			client.totalShards = this.options.shard[1];
			this.shardId = this.options.shard[0];
			this.totalShards = this.options.shard[1];
		}
		this.shouldReconnect = true;
		this.connect(false);
	}
	connect(resume = false) {
		this.stopReconnectTimer();
		this.stopHeartbeat();
		if (this.isConnecting) return;
		this.shouldReconnect = true;
		this.lastHeartbeatAck = true;
		this.ws?.close(1e3, "Reconnecting");
		const baseUrl = resume && this.resumeGatewayUrl ? this.resumeGatewayUrl : this.gatewayInfo?.url ?? this.options.url ?? DEFAULT_GATEWAY_URL;
		this.ws = this.createWebSocket(ensureGatewayParams(baseUrl));
		this.isConnecting = true;
		this.isConnected = false;
		this.setupWebSocket(resume);
	}
	disconnect() {
		this.shouldReconnect = false;
		this.stopReconnectTimer();
		this.stopHeartbeat();
		this.outboundLimiter.clear();
		this.ws?.close(1e3, "Client disconnect");
		this.ws = null;
		this.isConnecting = false;
		this.isConnected = false;
		this.reconnectAttempts = 0;
	}
	createWebSocket(url) {
		return new ws.WebSocket(url);
	}
	setupWebSocket(resume) {
		const socket = this.ws;
		if (!socket) return;
		socket.on("open", () => {
			if (socket !== this.ws) return;
			this.isConnecting = false;
			this.emitter.emit("debug", "Gateway websocket opened");
		});
		socket.on("message", (incoming) => {
			if (socket !== this.ws) return;
			const payload = decodeGatewayMessage(incoming);
			if (!payload) {
				this.emitter.emit("error", /* @__PURE__ */ new Error("Invalid gateway payload"));
				return;
			}
			this.handlePayload(payload, resume);
		});
		socket.on("close", (code) => {
			if (socket !== this.ws) return;
			const closeCode = code;
			this.stopHeartbeat();
			this.outboundLimiter.clear();
			this.isConnecting = false;
			this.isConnected = false;
			this.emitter.emit("debug", `Gateway websocket closed: ${code}`);
			if (!this.shouldReconnect) return;
			if (isFatalGatewayCloseCode(closeCode)) {
				this.shouldReconnect = false;
				this.emitter.emit("error", /* @__PURE__ */ new Error(`Fatal gateway close code: ${code}`));
				return;
			}
			const canResume = canResumeAfterGatewayClose(closeCode);
			if (!canResume) this.resetSessionState();
			this.scheduleReconnect(canResume, closeCode);
		});
		socket.on("error", (error) => {
			if (socket !== this.ws) return;
			this.emitter.emit("error", error);
		});
	}
	handlePayload(payload, resume) {
		if (payload.s !== null && payload.s !== void 0) this.sequence = payload.s;
		switch (payload.op) {
			case GatewayOpcodes.Hello:
				this.startHeartbeat(payload.d.heartbeat_interval ?? 45e3);
				if (resume && this.sessionId) this.send({
					op: GatewayOpcodes.Resume,
					d: {
						token: this.client?.options.token ?? "",
						session_id: this.sessionId,
						seq: this.sequence ?? 0
					}
				}, true);
				else this.identifyWithConcurrency().catch((error) => {
					this.emitter.emit("error", error instanceof Error ? error : new Error(String(error), { cause: error }));
				});
				break;
			case GatewayOpcodes.HeartbeatAck:
				this.lastHeartbeatAck = true;
				break;
			case GatewayOpcodes.Heartbeat:
				this.sendHeartbeat();
				break;
			case GatewayOpcodes.Dispatch:
				this.handleDispatch(payload).catch((error) => {
					this.emitter.emit("error", error instanceof Error ? error : new Error(String(error), { cause: error }));
				});
				break;
			case GatewayOpcodes.InvalidSession:
				if (!payload.d) this.resetSessionState();
				this.scheduleReconnect(payload.d, void 0, INVALID_SESSION_MIN_DELAY_MS + Math.floor(Math.random() * INVALID_SESSION_JITTER_MS));
				break;
			case GatewayOpcodes.Reconnect:
				this.scheduleReconnect(true);
				break;
		}
	}
	startHeartbeat(intervalMs) {
		this.heartbeatTimers.start({
			intervalMs,
			isAcked: () => this.lastHeartbeatAck,
			onHeartbeat: () => this.sendHeartbeat(),
			onAckTimeout: () => {
				this.emitter.emit("error", /* @__PURE__ */ new Error("Gateway heartbeat ACK timeout"));
				this.scheduleReconnect(true);
			}
		});
	}
	stopHeartbeat() {
		this.heartbeatTimers.stop();
	}
	stopReconnectTimer() {
		this.reconnectTimer.stop();
	}
	sendHeartbeat() {
		if (!this.ws || this.ws.readyState !== READY_STATE_OPEN) return;
		this.lastHeartbeatAck = false;
		this.send({
			op: GatewayOpcodes.Heartbeat,
			d: this.sequence
		}, true);
	}
	identify() {
		this.send({
			op: GatewayOpcodes.Identify,
			d: {
				token: this.client?.options.token ?? "",
				intents: this.options.intents ?? 0,
				properties: {
					os: process.platform,
					browser: "openclaw",
					device: "openclaw"
				},
				shard: this.options.shard
			}
		}, true);
	}
	async identifyWithConcurrency() {
		await sharedGatewayIdentifyLimiter.wait({
			shardId: this.shardId,
			maxConcurrency: this.gatewayInfo?.session_start_limit.max_concurrency
		});
		const socket = this.ws;
		if (!socket || socket.readyState !== READY_STATE_OPEN) {
			const error = /* @__PURE__ */ new Error("Discord gateway socket closed before IDENTIFY could be sent");
			this.emitter.emit("error", error);
			if (socket) this.scheduleReconnect(false);
			return;
		}
		this.identify();
	}
	send(payload, skipRateLimit = false) {
		if (!this.ws || this.ws.readyState !== READY_STATE_OPEN) throw new Error("Discord gateway socket is not open");
		const serialized = JSON.stringify(payload);
		if ((typeof Buffer !== "undefined" ? Buffer.byteLength(serialized, "utf8") : new TextEncoder().encode(serialized).byteLength) > DISCORD_GATEWAY_PAYLOAD_LIMIT_BYTES) throw new Error(`Discord gateway payload exceeds ${DISCORD_GATEWAY_PAYLOAD_LIMIT_BYTES}-byte limit`);
		this.outboundLimiter.send(serialized, { critical: skipRateLimit });
	}
	sendSerializedGatewayEvent(serialized) {
		if (!this.ws || this.ws.readyState !== READY_STATE_OPEN) throw new Error("Discord gateway socket is not open");
		this.ws.send(serialized);
	}
	async handleDispatch(payload) {
		if (!this.client || !payload.t) return;
		if (payload.t === GatewayDispatchEvents.Ready) {
			const ready = payload.d;
			this.sessionId = ready.session_id ?? null;
			this.resumeGatewayUrl = ready.resume_gateway_url ?? null;
			this.reconnectAttempts = 0;
			this.isConnected = true;
		}
		if (payload.t === GatewayDispatchEvents.Resumed) {
			this.reconnectAttempts = 0;
			this.isConnected = true;
		}
		dispatchVoiceGatewayEvent(this.client, payload.t, payload.d);
		const data = mapGatewayDispatchData(this.client, payload.t, payload.d);
		await this.client.dispatchGatewayEvent(payload.t, data);
		if (payload.t === GatewayDispatchEvents.InteractionCreate && this.options.autoInteractions) await this.client.handleInteraction(payload.d);
	}
	resetSessionState() {
		this.sessionId = null;
		this.resumeGatewayUrl = null;
		this.sequence = null;
	}
	scheduleReconnect(resume, closeCode, minDelayMs = 0) {
		if (!this.shouldReconnect) return;
		this.stopHeartbeat();
		this.stopReconnectTimer();
		this.ws?.close();
		this.ws = null;
		this.isConnecting = false;
		this.isConnected = false;
		this.outboundLimiter.clear();
		this.reconnectAttempts += 1;
		if (this.reconnectAttempts > (this.options.reconnect?.maxAttempts ?? 50)) {
			const maxAttempts = this.options.reconnect?.maxAttempts ?? 50;
			this.emitter.emit("error", /* @__PURE__ */ new Error(`Max reconnect attempts (${maxAttempts}) reached${closeCode !== void 0 ? ` after close code ${closeCode}` : ""}`));
			return;
		}
		const delay = Math.max(minDelayMs, Math.min(3e4, 1e3 * 2 ** Math.min(this.reconnectAttempts, 5)));
		this.reconnectTimer.schedule(delay, () => {
			this.connect(resume);
		});
	}
	updatePresence(data) {
		this.send({
			op: GatewayOpcodes.PresenceUpdate,
			d: data
		});
	}
	updateVoiceState(data) {
		this.send({
			op: GatewayOpcodes.VoiceStateUpdate,
			d: data
		}, true);
	}
	requestGuildMembers(data) {
		if (!this.hasIntent(GatewayIntentBits.GuildMembers)) throw new Error("GUILD_MEMBERS intent is required for requestGuildMembers");
		if (data.presences && !this.hasIntent(GatewayIntentBits.GuildPresences)) throw new Error("GUILD_PRESENCES intent is required when requesting presences");
		if (!data.query && data.query !== "" && !data.user_ids) throw new Error("Either query or user_ids is required for requestGuildMembers");
		this.send({
			op: GatewayOpcodes.RequestGuildMembers,
			d: data
		});
	}
	getRateLimitStatus() {
		return this.outboundLimiter.getStatus();
	}
	getIntentsInfo() {
		return {
			intents: this.options.intents ?? 0,
			hasGuilds: this.hasIntent(GatewayIntentBits.Guilds),
			hasGuildMembers: this.hasIntent(GatewayIntentBits.GuildMembers),
			hasGuildPresences: this.hasIntent(GatewayIntentBits.GuildPresences),
			hasGuildMessages: this.hasIntent(GatewayIntentBits.GuildMessages),
			hasMessageContent: this.hasIntent(GatewayIntentBits.MessageContent)
		};
	}
	hasIntent(intent) {
		return Boolean((this.options.intents ?? 0) & intent);
	}
};
//#endregion
//#region extensions/discord/src/monitor/presence.ts
const DEFAULT_CUSTOM_ACTIVITY_TYPE$1 = 4;
const CUSTOM_STATUS_NAME$1 = "Custom Status";
function resolveDiscordPresenceUpdate(config) {
	const activityText = normalizeOptionalString(config.activity) ?? "";
	const status = normalizeOptionalString(config.status) ?? "";
	const activityType = config.activityType;
	const activityUrl = normalizeOptionalString(config.activityUrl) ?? "";
	const hasActivity = Boolean(activityText);
	if (!hasActivity && !Boolean(status)) return {
		since: null,
		activities: [],
		status: "online",
		afk: false
	};
	const activities = [];
	if (hasActivity) {
		const resolvedType = activityType ?? DEFAULT_CUSTOM_ACTIVITY_TYPE$1;
		const activity = resolvedType === DEFAULT_CUSTOM_ACTIVITY_TYPE$1 ? {
			name: CUSTOM_STATUS_NAME$1,
			type: resolvedType,
			state: activityText
		} : {
			name: activityText,
			type: resolvedType
		};
		if (resolvedType === 1 && activityUrl) activity.url = activityUrl;
		activities.push(activity);
	}
	return {
		since: null,
		activities,
		status: status || "online",
		afk: false
	};
}
//#endregion
//#region extensions/discord/src/monitor/auto-presence.ts
const DEFAULT_CUSTOM_ACTIVITY_TYPE = 4;
const CUSTOM_STATUS_NAME = "Custom Status";
const DEFAULT_INTERVAL_MS = 3e4;
const DEFAULT_MIN_UPDATE_INTERVAL_MS = 15e3;
const MIN_INTERVAL_MS = 5e3;
const MIN_UPDATE_INTERVAL_MS = 1e3;
function normalizeOptionalText(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function clampPositiveInt(value, fallback, minValue) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	if (rounded <= 0) return fallback;
	return Math.max(minValue, rounded);
}
function resolveAutoPresenceConfig(config) {
	const intervalMs = clampPositiveInt(config?.intervalMs, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);
	const minUpdateIntervalMs = clampPositiveInt(config?.minUpdateIntervalMs, DEFAULT_MIN_UPDATE_INTERVAL_MS, MIN_UPDATE_INTERVAL_MS);
	return {
		enabled: config?.enabled === true,
		intervalMs,
		minUpdateIntervalMs,
		healthyText: normalizeOptionalText(config?.healthyText),
		degradedText: normalizeOptionalText(config?.degradedText),
		exhaustedText: normalizeOptionalText(config?.exhaustedText)
	};
}
function buildCustomStatusActivity(text) {
	return {
		name: CUSTOM_STATUS_NAME,
		type: DEFAULT_CUSTOM_ACTIVITY_TYPE,
		state: text
	};
}
function renderTemplate(template, vars) {
	const rendered = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_full, key) => vars[key] ?? "").replace(/\s+/g, " ").trim();
	return rendered.length > 0 ? rendered : void 0;
}
function isExhaustedUnavailableReason(reason) {
	if (!reason) return false;
	return reason === "rate_limit" || reason === "overloaded" || reason === "billing" || reason === "auth" || reason === "auth_permanent";
}
function formatUnavailableReason(reason) {
	if (!reason) return "unknown";
	return reason.replace(/_/g, " ");
}
function resolveAuthAvailability(params) {
	const profileIds = Object.keys(params.store.profiles);
	if (profileIds.length === 0) return {
		state: "degraded",
		unavailableReason: null
	};
	clearExpiredCooldowns(params.store, params.now);
	if (profileIds.some((profileId) => !isProfileInCooldown(params.store, profileId, params.now))) return {
		state: "healthy",
		unavailableReason: null
	};
	const unavailableReason = resolveProfilesUnavailableReason({
		store: params.store,
		profileIds,
		now: params.now
	});
	if (isExhaustedUnavailableReason(unavailableReason)) return {
		state: "exhausted",
		unavailableReason
	};
	return {
		state: "degraded",
		unavailableReason
	};
}
function resolvePresenceActivities(params) {
	const reasonLabel = formatUnavailableReason(params.unavailableReason ?? null);
	if (params.state === "healthy") {
		if (params.cfg.healthyText) return [buildCustomStatusActivity(params.cfg.healthyText)];
		return params.basePresence?.activities ?? [];
	}
	if (params.state === "degraded") {
		const text = renderTemplate(params.cfg.degradedText ?? "runtime degraded", { reason: reasonLabel });
		return text ? [buildCustomStatusActivity(text)] : [];
	}
	const defaultTemplate = isExhaustedUnavailableReason(params.unavailableReason ?? null) ? "token exhausted" : "model unavailable ({reason})";
	const text = renderTemplate(params.cfg.exhaustedText ?? defaultTemplate, { reason: reasonLabel });
	return text ? [buildCustomStatusActivity(text)] : [];
}
function resolvePresenceStatus(state) {
	if (state === "healthy") return "online";
	if (state === "exhausted") return "dnd";
	return "idle";
}
function resolveDiscordAutoPresenceDecision(params) {
	const autoPresence = resolveAutoPresenceConfig(params.discordConfig.autoPresence);
	if (!autoPresence.enabled) return null;
	const now = params.now ?? Date.now();
	const basePresence = resolveDiscordPresenceUpdate(params.discordConfig);
	const availability = resolveAuthAvailability({
		store: params.authStore,
		now
	});
	const state = params.gatewayConnected ? availability.state : "degraded";
	const unavailableReason = params.gatewayConnected ? availability.unavailableReason : availability.unavailableReason ?? "unknown";
	return {
		state,
		unavailableReason,
		presence: {
			since: null,
			activities: resolvePresenceActivities({
				state,
				cfg: autoPresence,
				basePresence,
				unavailableReason
			}),
			status: resolvePresenceStatus(state),
			afk: false
		}
	};
}
function stablePresenceSignature(payload) {
	return JSON.stringify({
		status: payload.status,
		afk: payload.afk,
		since: payload.since,
		activities: payload.activities.map((activity) => ({
			type: activity.type,
			name: activity.name,
			state: activity.state,
			url: activity.url
		}))
	});
}
function createDiscordAutoPresenceController(params) {
	const autoCfg = resolveAutoPresenceConfig(params.discordConfig.autoPresence);
	if (!autoCfg.enabled) return {
		enabled: false,
		start: () => void 0,
		stop: () => void 0,
		refresh: () => void 0,
		runNow: () => void 0
	};
	const loadAuthStore = params.loadAuthStore ?? (() => ensureAuthProfileStore());
	const now = params.now ?? (() => Date.now());
	const setIntervalFn = params.setIntervalFn ?? setInterval;
	const clearIntervalFn = params.clearIntervalFn ?? clearInterval;
	let timer;
	let lastAppliedSignature = null;
	let lastAppliedAt = 0;
	const runEvaluation = (options) => {
		let decision = null;
		try {
			decision = resolveDiscordAutoPresenceDecision({
				discordConfig: params.discordConfig,
				authStore: loadAuthStore(),
				gatewayConnected: params.gateway.isConnected,
				now: now()
			});
		} catch (err) {
			params.log?.(warn(`discord: auto-presence evaluation failed for account ${params.accountId}: ${String(err)}`));
			return;
		}
		if (!decision || !params.gateway.isConnected) return;
		const forceApply = options?.force === true;
		const ts = now();
		const signature = stablePresenceSignature(decision.presence);
		if (!forceApply && signature === lastAppliedSignature) return;
		if (!forceApply && lastAppliedAt > 0 && ts - lastAppliedAt < autoCfg.minUpdateIntervalMs) return;
		params.gateway.updatePresence(decision.presence);
		lastAppliedSignature = signature;
		lastAppliedAt = ts;
	};
	return {
		enabled: true,
		runNow: () => runEvaluation(),
		refresh: () => runEvaluation({ force: true }),
		start: () => {
			if (timer) return;
			runEvaluation({ force: true });
			timer = setIntervalFn(() => runEvaluation(), autoCfg.intervalMs);
		},
		stop: () => {
			if (!timer) return;
			clearIntervalFn(timer);
			timer = void 0;
		}
	};
}
//#endregion
//#region extensions/discord/src/monitor/gateway-handle.ts
const DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT = "openclaw:discord-gateway-transport-activity";
//#endregion
//#region extensions/discord/src/monitor/gateway-metadata.ts
const DISCORD_GATEWAY_BOT_URL = "https://discord.com/api/v10/gateway/bot";
const DISCORD_API_HOST = "discord.com";
const DEFAULT_DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/";
const DEFAULT_DISCORD_GATEWAY_INFO_TIMEOUT_MS = 3e4;
const MAX_DISCORD_GATEWAY_INFO_TIMEOUT_MS = 12e4;
const DISCORD_GATEWAY_INFO_TIMEOUT_ENV = "OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS";
const DISCORD_GATEWAY_METADATA_FALLBACK_LOG_INTERVAL_MS = 6e4;
const discordGatewayBotInfoSchema = Type.Object({
	url: Type.String({ minLength: 1 }),
	shards: Type.Integer({ minimum: 1 }),
	session_start_limit: Type.Object({
		total: Type.Integer({ minimum: 0 }),
		remaining: Type.Integer({ minimum: 0 }),
		reset_after: Type.Number({ minimum: 0 }),
		max_concurrency: Type.Integer({ minimum: 1 })
	})
});
const gatewayMetadataFallbackLogLastAt = /* @__PURE__ */ new WeakMap();
function resolveFetchInputUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}
async function materializeGuardedResponse(response) {
	const body = await response.arrayBuffer();
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
}
function normalizeGatewayInfoTimeoutMs(value) {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(numeric) || numeric <= 0) return;
	return Math.min(Math.floor(numeric), MAX_DISCORD_GATEWAY_INFO_TIMEOUT_MS);
}
function resolveDiscordGatewayInfoTimeoutMs(params) {
	return normalizeGatewayInfoTimeoutMs(params?.configuredTimeoutMs) ?? normalizeGatewayInfoTimeoutMs(params?.env?.[DISCORD_GATEWAY_INFO_TIMEOUT_ENV]) ?? DEFAULT_DISCORD_GATEWAY_INFO_TIMEOUT_MS;
}
function summarizeGatewayResponseBody(body) {
	return summarizeDiscordResponseBody(body, { emptyText: "<empty>" }) ?? "<empty>";
}
function isDiscordGatewayRateLimitResponse(status, body) {
	return status === 429 && isDiscordRateLimitResponseBody(body);
}
function isTransientDiscordGatewayResponse(status, body) {
	if (status >= 500) return true;
	if (isDiscordGatewayRateLimitResponse(status, body)) return true;
	const normalized = body.toLowerCase();
	return normalized.includes("upstream connect error") || normalized.includes("disconnect/reset before headers") || normalized.includes("reset reason:");
}
function createGatewayMetadataError(params) {
	const error = new Error(params.transient ? "Failed to get gateway information from Discord: fetch failed" : `Failed to get gateway information from Discord: ${params.detail}`, { cause: params.cause ?? (params.transient ? new Error(params.detail) : void 0) });
	Object.defineProperty(error, "transient", {
		value: params.transient,
		enumerable: false
	});
	return error;
}
function isTransientGatewayMetadataError(error) {
	return Boolean(error?.transient);
}
function createDefaultGatewayInfo() {
	return {
		url: DEFAULT_DISCORD_GATEWAY_URL,
		shards: 1,
		session_start_limit: {
			total: 1,
			remaining: 1,
			reset_after: 0,
			max_concurrency: 1
		}
	};
}
function summarizeGatewaySchemaErrors(value) {
	const errors = Errors(discordGatewayBotInfoSchema, value);
	if (errors.length === 0) return "unknown schema mismatch";
	return errors.slice(0, 3).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}
function parseDiscordGatewayInfoBody(body) {
	const parsed = JSON.parse(body);
	if (!Check(discordGatewayBotInfoSchema, parsed)) throw new Error(summarizeGatewaySchemaErrors(parsed));
	return parsed;
}
async function fetchDiscordGatewayInfo(params) {
	let response;
	try {
		response = await params.fetchImpl(DISCORD_GATEWAY_BOT_URL, {
			...params.fetchInit,
			headers: {
				...params.fetchInit?.headers,
				Authorization: `Bot ${params.token}`
			}
		});
	} catch (error) {
		throw createGatewayMetadataError({
			detail: formatErrorMessage(error),
			transient: true,
			cause: error
		});
	}
	let body;
	try {
		body = await response.text();
	} catch (error) {
		throw createGatewayMetadataError({
			detail: formatErrorMessage(error),
			transient: true,
			cause: error
		});
	}
	const summary = summarizeGatewayResponseBody(body);
	const transient = isTransientDiscordGatewayResponse(response.status, body);
	if (!response.ok) throw createGatewayMetadataError({
		detail: `Discord API /gateway/bot failed (${response.status}): ${summary}`,
		transient
	});
	try {
		return parseDiscordGatewayInfoBody(body);
	} catch (error) {
		throw createGatewayMetadataError({
			detail: `Discord API /gateway/bot returned invalid metadata: ${formatErrorMessage(error)} (${summary})`,
			transient,
			cause: error
		});
	}
}
async function fetchDiscordGatewayInfoWithTimeout(params) {
	const timeoutMs = Math.max(1, params.timeoutMs ?? DEFAULT_DISCORD_GATEWAY_INFO_TIMEOUT_MS);
	return await withAbortTimeout({
		timeoutMs,
		createTimeoutError: () => createGatewayMetadataError({
			detail: `Discord API /gateway/bot timed out after ${timeoutMs}ms`,
			transient: true,
			cause: /* @__PURE__ */ new Error("gateway metadata timeout")
		}),
		run: async (signal) => await fetchDiscordGatewayInfo({
			token: params.token,
			fetchImpl: params.fetchImpl,
			fetchInit: {
				...params.fetchInit,
				signal
			}
		})
	});
}
function resolveGatewayInfoWithFallback(params) {
	if (!isTransientGatewayMetadataError(params.error)) throw params.error;
	const message = formatErrorMessage(params.error);
	const now = Date.now();
	if (params.runtime) {
		const previous = gatewayMetadataFallbackLogLastAt.get(params.runtime);
		if (previous === void 0 || now - previous >= DISCORD_GATEWAY_METADATA_FALLBACK_LOG_INTERVAL_MS) {
			params.runtime.log?.(`discord: gateway metadata lookup failed transiently; using default gateway url (${message})`);
			gatewayMetadataFallbackLogLastAt.set(params.runtime, now);
		}
	}
	return {
		info: createDefaultGatewayInfo(),
		usedFallback: true
	};
}
async function fetchDiscordGatewayMetadataDirect(input, init, capture) {
	const guarded = await fetchWithSsrFGuard({
		url: resolveFetchInputUrl(input),
		init,
		policy: { allowedHostnames: [DISCORD_API_HOST] },
		capture: false,
		auditContext: "discord.gateway.metadata"
	});
	let response;
	try {
		response = await materializeGuardedResponse(guarded.response);
	} finally {
		await guarded.release();
	}
	if (capture) captureHttpExchange({
		url: input,
		method: init?.method ?? "GET",
		requestHeaders: init?.headers,
		requestBody: init?.body ?? null,
		response,
		flowId: capture.flowId,
		meta: capture.meta
	});
	return response;
}
//#endregion
//#region extensions/discord/src/monitor/gateway-plugin.ts
const DISCORD_GATEWAY_HANDSHAKE_TIMEOUT_MS = 3e4;
const registrationPromises = /* @__PURE__ */ new WeakMap();
function assignGatewayClient(plugin, client) {
	plugin.client = client;
}
function hasGatewaySocketStarted(plugin) {
	const state = plugin;
	return state.ws != null || state.isConnecting === true;
}
function resolveDiscordGatewayIntents(params) {
	const intentsConfig = params?.intentsConfig;
	const voiceEnabled = params?.voiceEnabled;
	const voiceStatesEnabled = intentsConfig?.voiceStates ?? voiceEnabled ?? false;
	let intents = GatewayIntents.Guilds | GatewayIntents.GuildMessages | GatewayIntents.MessageContent | GatewayIntents.DirectMessages | GatewayIntents.GuildMessageReactions | GatewayIntents.DirectMessageReactions;
	if (voiceStatesEnabled) intents |= GatewayIntents.GuildVoiceStates;
	if (intentsConfig?.presence) intents |= GatewayIntents.GuildPresences;
	if (intentsConfig?.guildMembers) intents |= GatewayIntents.GuildMembers;
	return intents;
}
function createGatewayPlugin(params) {
	class OpenClawGatewayPlugin extends GatewayPlugin {
		constructor() {
			super(params.options);
			this.gatewayInfoUsedFallback = false;
		}
		registerClient(client) {
			const registration = this.registerClientInternal(client);
			registration.catch(() => {});
			registrationPromises.set(this, registration);
			return registration;
		}
		async registerClientInternal(client) {
			assignGatewayClient(this, client);
			if (!this.gatewayInfo || this.gatewayInfoUsedFallback) {
				const resolved = await fetchDiscordGatewayInfoWithTimeout({
					token: client.options.token,
					fetchImpl: params.fetchImpl,
					fetchInit: params.fetchInit,
					timeoutMs: params.gatewayInfoTimeoutMs
				}).then((info) => ({
					info,
					usedFallback: false
				})).catch((error) => resolveGatewayInfoWithFallback({
					runtime: params.runtime,
					error
				}));
				this.gatewayInfo = resolved.info;
				this.gatewayInfoUsedFallback = resolved.usedFallback;
			}
			if (params.testing?.registerClient) {
				await params.testing.registerClient(this, client);
				return;
			}
			if (hasGatewaySocketStarted(this)) return;
			return super.registerClient(client);
		}
		createWebSocket(url) {
			if (!url) throw new Error("Gateway URL is required");
			const wsFlowId = randomUUID();
			const socket = new (params.testing?.webSocketCtor ?? ws.default)(url, {
				handshakeTimeout: DISCORD_GATEWAY_HANDSHAKE_TIMEOUT_MS,
				...params.wsAgent ? { agent: params.wsAgent } : {}
			});
			const emitTransportActivity = () => {
				if (this.ws !== socket) return;
				this.emitter.emit(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, { at: Date.now() });
			};
			captureWsEvent({
				url,
				direction: "local",
				kind: "ws-open",
				flowId: wsFlowId,
				meta: { subsystem: "discord-gateway" }
			});
			socket.on?.("message", (data) => {
				emitTransportActivity();
				captureWsEvent({
					url,
					direction: "inbound",
					kind: "ws-frame",
					flowId: wsFlowId,
					payload: Buffer.isBuffer(data) ? data : Buffer.from(String(data)),
					meta: { subsystem: "discord-gateway" }
				});
			});
			socket.on?.("close", (code, reason) => {
				captureWsEvent({
					url,
					direction: "local",
					kind: "ws-close",
					flowId: wsFlowId,
					closeCode: code,
					payload: reason,
					meta: { subsystem: "discord-gateway" }
				});
			});
			socket.on?.("error", (error) => {
				captureWsEvent({
					url,
					direction: "local",
					kind: "error",
					flowId: wsFlowId,
					errorText: error.message,
					meta: { subsystem: "discord-gateway" }
				});
			});
			if ("binaryType" in socket) try {
				socket.binaryType = "arraybuffer";
			} catch {}
			return socket;
		}
	}
	return new OpenClawGatewayPlugin();
}
function createDiscordGatewayMetadataFetch(debugCaptureEnabled) {
	return (input, init) => fetchDiscordGatewayMetadataDirect(input, init, debugCaptureEnabled ? false : {
		flowId: randomUUID(),
		meta: { subsystem: "discord-gateway-metadata" }
	});
}
function waitForDiscordGatewayPluginRegistration(plugin) {
	if (typeof plugin !== "object" || plugin === null) return;
	return registrationPromises.get(plugin);
}
function createDiscordGatewayPlugin(params) {
	const intents = resolveDiscordGatewayIntents({
		intentsConfig: params.discordConfig?.intents,
		voiceEnabled: resolveDiscordVoiceEnabled(params.discordConfig?.voice)
	});
	const proxy = resolveEffectiveDebugProxyUrl(params.discordConfig?.proxy);
	const debugProxySettings = resolveDebugProxySettings();
	const gatewayInfoTimeoutMs = resolveDiscordGatewayInfoTimeoutMs({
		configuredTimeoutMs: params.discordConfig?.gatewayInfoTimeoutMs,
		env: process.env
	});
	let fetchImpl = createDiscordGatewayMetadataFetch(debugProxySettings.enabled);
	let wsAgent;
	if (proxy) try {
		validateDiscordProxyUrl(proxy);
		wsAgent = new (params.__testing?.HttpsProxyAgentCtor ?? httpsProxyAgent.HttpsProxyAgent)(proxy);
		params.runtime.log?.("discord: gateway proxy enabled");
	} catch (err) {
		params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
		fetchImpl = (input, init) => fetchDiscordGatewayMetadataDirect(input, init, false);
	}
	return createGatewayPlugin({
		options: {
			reconnect: { maxAttempts: 50 },
			intents,
			autoInteractions: false
		},
		gatewayInfoTimeoutMs,
		fetchImpl,
		runtime: params.runtime,
		testing: params.__testing,
		...wsAgent ? { wsAgent } : {}
	});
}
//#endregion
//#region extensions/discord/src/monitor/gateway-supervisor.ts
var DiscordGatewayLifecycleError = class extends Error {
	constructor(event) {
		super(`discord gateway ${event.type}: ${event.message}`, { cause: event.err instanceof Error ? event.err : void 0 });
		this.name = "DiscordGatewayLifecycleError";
		this.eventType = event.type;
	}
};
function getDiscordGatewayEmitter(gateway) {
	return gateway?.emitter;
}
function readFirstStackFrame(err) {
	const stack = err.stack;
	if (!stack) return;
	const frame = stack.split("\n").slice(1).map((line) => line.trim()).find(Boolean);
	return frame ? frame.replace(/^at\s+/, "") : void 0;
}
function formatDiscordGatewayErrorMessage(err) {
	if (!(err instanceof Error)) return formatErrorMessage$1(err);
	if (err.message) {
		const detail = formatErrorMessage$1(err);
		return err.name ? `${err.name}: ${detail}` : detail;
	}
	const detail = formatErrorMessage$1(err);
	const firstFrame = readFirstStackFrame(err);
	if (firstFrame && detail === (err.name || "Error")) return `${detail} @ ${firstFrame}`;
	return detail;
}
function classifyDiscordGatewayEvent(params) {
	const message = formatDiscordGatewayErrorMessage(params.err);
	if (params.isDisallowedIntentsError(params.err)) return {
		type: "disallowed-intents",
		err: params.err,
		message,
		shouldStopLifecycle: true
	};
	if (message.includes("Max reconnect attempts")) return {
		type: "reconnect-exhausted",
		err: params.err,
		message,
		shouldStopLifecycle: true
	};
	if (params.err instanceof TypeError || message.includes("Fatal Gateway error") || message.includes("Fatal gateway close code") || message.includes("Gateway HELLO missing heartbeat") || message.includes("Invalid gateway payload") || message.includes("Gateway socket emitted an unknown error")) return {
		type: "fatal",
		err: params.err,
		message,
		shouldStopLifecycle: true
	};
	return {
		type: "other",
		err: params.err,
		message,
		shouldStopLifecycle: false
	};
}
function createDiscordGatewaySupervisor(params) {
	const emitter = getDiscordGatewayEmitter(params.gateway);
	const pending = [];
	if (!emitter) return {
		attachLifecycle: () => {},
		detachLifecycle: () => {},
		drainPending: () => "continue",
		dispose: () => {},
		emitter
	};
	let lifecycleHandler;
	let phase = "buffering";
	const seenLateEventKeys = /* @__PURE__ */ new Set();
	const logLateEvent = (state) => (event) => {
		const key = `${state}:${event.type}:${event.message}`;
		if (seenLateEventKeys.has(key)) return;
		seenLateEventKeys.add(key);
		params.runtime.error?.(danger(`discord: suppressed late gateway ${event.type} error ${state === "disposed" ? "after dispose" : "during teardown"}: ${event.message}`));
	};
	const onGatewayError = (err) => {
		const event = classifyDiscordGatewayEvent({
			err,
			isDisallowedIntentsError: params.isDisallowedIntentsError
		});
		switch (phase) {
			case "disposed":
				logLateEvent("disposed")(event);
				return;
			case "active":
				lifecycleHandler?.(event);
				return;
			case "teardown":
				logLateEvent("teardown")(event);
				return;
			case "buffering":
				pending.push(event);
				return;
		}
	};
	emitter.on("error", onGatewayError);
	return {
		emitter,
		attachLifecycle: (handler) => {
			lifecycleHandler = handler;
			phase = "active";
		},
		detachLifecycle: () => {
			lifecycleHandler = void 0;
			phase = "teardown";
		},
		drainPending: (handler) => {
			if (pending.length === 0) return "continue";
			const queued = [...pending];
			pending.length = 0;
			for (const event of queued) if (handler(event) === "stop") return "stop";
			return "continue";
		},
		dispose: () => {
			if (phase === "disposed") return;
			lifecycleHandler = void 0;
			phase = "disposed";
			pending.length = 0;
		}
	};
}
//#endregion
//#region extensions/discord/src/monitor/provider.acp.ts
const DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS = 8e3;
const DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS = 120 * 1e3;
function isLegacyMissingSessionError(message) {
	return message.includes("Session is not ACP-enabled") || message.includes("ACP session metadata missing");
}
function classifyAcpStatusProbeError(params) {
	if (params.isAcpRuntimeError(params.error) && params.error.code === "ACP_SESSION_INIT_FAILED") return {
		status: "stale",
		reason: "session-init-failed"
	};
	if (isLegacyMissingSessionError(formatErrorMessage$1(params.error))) return {
		status: "stale",
		reason: "session-missing"
	};
	return params.isStaleRunning ? {
		status: "stale",
		reason: "status-error-running-stale"
	} : {
		status: "uncertain",
		reason: "status-error"
	};
}
async function probeDiscordAcpBindingHealth(params) {
	const { getAcpSessionManager, isAcpRuntimeError } = params.providerSessionRuntime;
	const manager = getAcpSessionManager();
	const statusProbeAbortController = new AbortController();
	const result = await raceWithTimeout({
		promise: manager.getSessionStatus({
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			signal: statusProbeAbortController.signal
		}).then((status) => ({
			kind: "status",
			status
		})).catch((error) => ({
			kind: "error",
			error
		})),
		timeoutMs: DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS,
		onTimeout: () => ({ kind: "timeout" })
	});
	if (result.kind === "timeout") statusProbeAbortController.abort();
	const runningForMs = params.storedState === "running" && Number.isFinite(params.lastActivityAt) ? Date.now() - Math.max(0, Math.floor(params.lastActivityAt ?? 0)) : 0;
	const isStaleRunning = params.storedState === "running" && runningForMs >= DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS;
	if (result.kind === "timeout") return isStaleRunning ? {
		status: "stale",
		reason: "status-timeout-running-stale"
	} : {
		status: "uncertain",
		reason: "status-timeout"
	};
	if (result.kind === "error") return classifyAcpStatusProbeError({
		error: result.error,
		isStaleRunning,
		isAcpRuntimeError
	});
	if (result.status.state === "error") return {
		status: "uncertain",
		reason: "status-error-state"
	};
	return { status: "healthy" };
}
//#endregion
//#region extensions/discord/src/monitor/provider.allowlist.ts
function formatResolutionLogDetails(base, details) {
	const nonEmpty = details.map((value) => value?.trim()).filter((value) => Boolean(value));
	return nonEmpty.length > 0 ? `${base} (${nonEmpty.join("; ")})` : base;
}
function formatResolvedBase(input, target) {
	if (!target) return input;
	return input === target ? input : `${input}→${target}`;
}
function formatAliasSummary(aliases) {
	if (aliases.length === 0) return;
	const preview = aliases.slice(0, 3).join(", ");
	if (aliases.length <= 3) return preview;
	return `${preview}, +${aliases.length - 3} more`;
}
function formatDiscordChannelResolvedGroup(entry) {
	const aliasSummary = formatAliasSummary(entry.aliases);
	return formatResolutionLogDetails(entry.target, [
		entry.guildName ? `guild:${entry.guildName}` : void 0,
		entry.channelName ? `channel:${entry.channelName}` : void 0,
		entry.note,
		aliasSummary ? `aliases:${aliasSummary}` : void 0
	]);
}
function formatDiscordChannelUnresolved(entry) {
	return formatResolutionLogDetails(entry.input, [
		entry.guildName ? `guild:${entry.guildName}` : entry.guildId ? `guildId:${entry.guildId}` : void 0,
		entry.channelName ? `channel:${entry.channelName}` : entry.channelId ? `channelId:${entry.channelId}` : void 0,
		entry.note
	]);
}
function formatDiscordUserResolved(entry) {
	const displayName = entry.name?.trim();
	const target = displayName || entry.id;
	return formatResolutionLogDetails(formatResolvedBase(entry.input, target), [
		displayName && entry.id ? `id:${entry.id}` : void 0,
		entry.guildName ? `guild:${entry.guildName}` : void 0,
		entry.note
	]);
}
function formatDiscordUserUnresolved(entry) {
	return formatResolutionLogDetails(entry.input, [
		entry.name ? `name:${entry.name}` : void 0,
		entry.guildName ? `guild:${entry.guildName}` : void 0,
		entry.note
	]);
}
function toGuildEntries(value) {
	if (!value || typeof value !== "object") return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!entry || typeof entry !== "object") continue;
		out[key] = entry;
	}
	return out;
}
function toAllowlistEntries(value) {
	if (!Array.isArray(value)) return;
	return normalizeStringEntries(value);
}
function hasGuildEntries(value) {
	return Object.keys(value).length > 0;
}
function collectChannelResolutionInputs(guildEntries) {
	const entries = [];
	for (const [guildKey, guildCfg] of Object.entries(guildEntries)) {
		if (guildKey === "*") continue;
		const channels = guildCfg?.channels ?? {};
		const channelKeys = Object.keys(channels).filter((key) => key !== "*");
		if (channelKeys.length === 0) {
			const input = /^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey;
			entries.push({
				input,
				guildKey
			});
			continue;
		}
		for (const channelKey of channelKeys) entries.push({
			input: `${guildKey}/${channelKey}`,
			guildKey,
			channelKey
		});
	}
	return entries;
}
async function resolveGuildEntriesByChannelAllowlist(params) {
	const entries = collectChannelResolutionInputs(params.guildEntries);
	if (entries.length === 0) return params.guildEntries;
	try {
		const resolved = await resolveDiscordChannelAllowlist({
			token: params.token,
			entries: entries.map((entry) => entry.input),
			fetcher: params.fetcher
		});
		const sourceByInput = new Map(entries.map((entry) => [entry.input, entry]));
		const nextGuilds = { ...params.guildEntries };
		const mappingByTarget = /* @__PURE__ */ new Map();
		const unresolved = [];
		for (const entry of resolved) {
			const source = sourceByInput.get(entry.input);
			if (!source) continue;
			const sourceGuild = params.guildEntries[source.guildKey] ?? {};
			if (!entry.resolved || !entry.guildId) {
				unresolved.push(formatDiscordChannelUnresolved(entry));
				continue;
			}
			const target = entry.channelId ? `${entry.guildId}/${entry.channelId}` : entry.guildId;
			const existingGroup = mappingByTarget.get(target) ?? {
				target,
				aliases: [],
				guildName: entry.guildName,
				channelName: entry.channelName,
				note: entry.note
			};
			if (entry.input !== target && !existingGroup.aliases.includes(entry.input)) existingGroup.aliases.push(entry.input);
			if (!existingGroup.guildName && entry.guildName) existingGroup.guildName = entry.guildName;
			if (!existingGroup.channelName && entry.channelName) existingGroup.channelName = entry.channelName;
			if (!existingGroup.note && entry.note) existingGroup.note = entry.note;
			mappingByTarget.set(target, existingGroup);
			const existing = nextGuilds[entry.guildId] ?? {};
			const mergedChannels = {
				...sourceGuild.channels,
				...existing.channels
			};
			const mergedGuild = {
				...sourceGuild,
				...existing,
				channels: mergedChannels
			};
			nextGuilds[entry.guildId] = mergedGuild;
			if (source.channelKey && entry.channelId) {
				const sourceChannel = sourceGuild.channels?.[source.channelKey];
				if (sourceChannel) nextGuilds[entry.guildId] = {
					...mergedGuild,
					channels: {
						...mergedChannels,
						[entry.channelId]: {
							...sourceChannel,
							...mergedChannels[entry.channelId]
						}
					}
				};
			}
		}
		summarizeMapping("discord channels", [...mappingByTarget.values()].map((group) => formatDiscordChannelResolvedGroup(group)), unresolved, params.runtime);
		return nextGuilds;
	} catch (err) {
		params.runtime.log?.(`discord channel resolve failed; using config entries. ${formatErrorMessage$1(err)}`);
		return params.guildEntries;
	}
}
async function resolveAllowFromByUserAllowlist(params) {
	const allowEntries = normalizeStringEntries(params.allowFrom).filter((entry) => entry !== "*");
	if (allowEntries.length === 0) return params.allowFrom;
	try {
		const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(await resolveDiscordUserAllowlist({
			token: params.token,
			entries: allowEntries,
			fetcher: params.fetcher
		}), {
			formatResolved: formatDiscordUserResolved,
			formatUnresolved: formatDiscordUserUnresolved
		});
		const allowFrom = canonicalizeAllowlistWithResolvedIds({
			existing: params.allowFrom,
			resolvedMap
		});
		summarizeMapping("discord users", mapping, unresolved, params.runtime);
		return allowFrom;
	} catch (err) {
		params.runtime.log?.(`discord user resolve failed; using config entries. ${formatErrorMessage$1(err)}`);
		return params.allowFrom;
	}
}
function collectGuildUserEntries(guildEntries) {
	const userEntries = /* @__PURE__ */ new Set();
	for (const guild of Object.values(guildEntries)) {
		if (!guild || typeof guild !== "object") continue;
		addAllowlistUserEntriesFromConfigEntry(userEntries, guild);
		const channels = guild.channels ?? {};
		for (const channel of Object.values(channels)) addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
	}
	return userEntries;
}
async function resolveGuildEntriesByUserAllowlist(params) {
	const userEntries = collectGuildUserEntries(params.guildEntries);
	if (userEntries.size === 0) return params.guildEntries;
	try {
		const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(await resolveDiscordUserAllowlist({
			token: params.token,
			entries: Array.from(userEntries),
			fetcher: params.fetcher
		}), {
			formatResolved: formatDiscordUserResolved,
			formatUnresolved: formatDiscordUserUnresolved
		});
		const nextGuilds = { ...params.guildEntries };
		for (const [guildKey, guildConfig] of Object.entries(params.guildEntries)) {
			if (!guildConfig || typeof guildConfig !== "object") continue;
			const nextGuild = { ...guildConfig };
			const users = guildConfig.users;
			if (Array.isArray(users) && users.length > 0) nextGuild.users = canonicalizeAllowlistWithResolvedIds({
				existing: users,
				resolvedMap
			});
			const channels = guildConfig.channels ?? {};
			if (channels && typeof channels === "object") nextGuild.channels = patchAllowlistUsersInConfigEntries({
				entries: channels,
				resolvedMap,
				strategy: "canonicalize"
			});
			nextGuilds[guildKey] = nextGuild;
		}
		summarizeMapping("discord channel users", mapping, unresolved, params.runtime);
		return nextGuilds;
	} catch (err) {
		params.runtime.log?.(`discord channel user resolve failed; using config entries. ${formatErrorMessage$1(err)}`);
		return params.guildEntries;
	}
}
async function resolveDiscordAllowlistConfig(params) {
	let guildEntries = toGuildEntries(params.guildEntries);
	let allowFrom = toAllowlistEntries(params.allowFrom);
	if (hasGuildEntries(guildEntries)) guildEntries = await resolveGuildEntriesByChannelAllowlist({
		token: params.token,
		guildEntries,
		fetcher: params.fetcher,
		runtime: params.runtime
	});
	allowFrom = await resolveAllowFromByUserAllowlist({
		token: params.token,
		allowFrom,
		fetcher: params.fetcher,
		runtime: params.runtime
	});
	if (hasGuildEntries(guildEntries)) guildEntries = await resolveGuildEntriesByUserAllowlist({
		token: params.token,
		guildEntries,
		fetcher: params.fetcher,
		runtime: params.runtime
	});
	return {
		guildEntries: hasGuildEntries(guildEntries) ? guildEntries : void 0,
		allowFrom
	};
}
//#endregion
//#region extensions/discord/src/monitor/provider.cleanup.ts
function cleanupDiscordProviderStartup(params) {
	params.deactivateMessageHandler?.();
	params.autoPresenceController?.stop();
	params.setStatus?.({ connected: false });
	if (params.onEarlyGatewayDebug) params.earlyGatewayEmitter?.removeListener("debug", params.onEarlyGatewayDebug);
	if (!params.lifecycleStarted) try {
		params.lifecycleGateway?.disconnect();
	} catch (err) {
		params.runtime.error?.(danger(`discord: failed to disconnect gateway during startup cleanup: ${String(err)}`));
	}
	params.gatewaySupervisor?.dispose();
	if (!params.lifecycleStarted) params.threadBindings.stop();
}
//#endregion
//#region extensions/discord/src/monitor/provider.commands.ts
let pluginRuntimePromise;
async function loadPluginRuntime() {
	const promise = pluginRuntimePromise ?? import("openclaw/plugin-sdk/plugin-runtime");
	pluginRuntimePromise = promise;
	try {
		return await promise;
	} catch (error) {
		if (pluginRuntimePromise === promise) pluginRuntimePromise = void 0;
		throw error;
	}
}
async function appendPluginCommandSpecs(params) {
	const merged = [...params.commandSpecs];
	const existingNames = new Set(merged.map((spec) => normalizeLowercaseStringOrEmpty(spec.name)).filter(Boolean));
	const getPluginCommandSpecs = params.getPluginCommandSpecs ?? (await loadPluginRuntime()).getPluginCommandSpecs;
	for (const pluginCommand of getPluginCommandSpecs("discord", { config: params.cfg })) {
		const normalizedName = normalizeLowercaseStringOrEmpty(pluginCommand.name);
		if (!normalizedName) continue;
		if (existingNames.has(normalizedName)) {
			params.runtime.error?.(danger(`discord: plugin command "/${normalizedName}" duplicates an existing native command. Skipping.`));
			continue;
		}
		existingNames.add(normalizedName);
		merged.push({
			name: pluginCommand.name,
			description: pluginCommand.description,
			acceptsArgs: pluginCommand.acceptsArgs
		});
	}
	return merged;
}
async function resolveDiscordProviderCommandSpecs(params) {
	const listSkillCommands = params.listSkillCommandsForAgents ?? listSkillCommandsForAgents;
	const listNativeCommandSpecs = params.listNativeCommandSpecsForConfig ?? listNativeCommandSpecsForConfig;
	const maxDiscordCommands = params.maxDiscordCommands ?? 100;
	let skillCommands = params.nativeEnabled && params.nativeSkillsEnabled ? listSkillCommands({ cfg: params.cfg }) : [];
	let commandSpecs = params.nativeEnabled ? listNativeCommandSpecs(params.cfg, {
		skillCommands,
		provider: "discord"
	}) : [];
	if (params.nativeEnabled) commandSpecs = await appendPluginCommandSpecs({
		commandSpecs,
		runtime: params.runtime,
		cfg: params.cfg,
		getPluginCommandSpecs: params.getPluginCommandSpecs
	});
	const initialCommandCount = commandSpecs.length;
	if (params.nativeEnabled && params.nativeSkillsEnabled && commandSpecs.length > maxDiscordCommands) {
		skillCommands = [];
		commandSpecs = listNativeCommandSpecs(params.cfg, {
			skillCommands: [],
			provider: "discord"
		});
		commandSpecs = await appendPluginCommandSpecs({
			commandSpecs,
			runtime: params.runtime,
			cfg: params.cfg,
			getPluginCommandSpecs: params.getPluginCommandSpecs
		});
		params.runtime.log?.(warn(`discord: ${initialCommandCount} commands exceeds limit; removing per-skill commands and keeping /skill.`));
	}
	if (params.nativeEnabled && commandSpecs.length > maxDiscordCommands) params.runtime.log?.(warn(`discord: ${commandSpecs.length} commands exceeds limit; some commands may fail to deploy.`));
	return {
		skillCommands,
		commandSpecs
	};
}
//#endregion
//#region extensions/discord/src/monitor/provider.config-log.ts
function formatThreadBindingDurationForConfigLabel(durationMs) {
	const label = formatThreadBindingDurationLabel(durationMs);
	return label === "disabled" ? "off" : label;
}
function logDiscordResolvedConfig(params) {
	const allowFromSummary = summarizeStringEntries({
		entries: params.allowFrom ?? [],
		limit: 4,
		emptyText: "any"
	});
	const groupDmChannelSummary = summarizeStringEntries({
		entries: params.groupDmChannels ?? [],
		limit: 4,
		emptyText: "any"
	});
	const guildSummary = summarizeStringEntries({
		entries: Object.keys(params.guildEntries ?? {}),
		limit: 4,
		emptyText: "any"
	});
	logVerbose(`discord: config dm=${params.dmEnabled ? "on" : "off"} dmPolicy=${params.dmPolicy} allowFrom=${allowFromSummary} groupDm=${params.groupDmEnabled ? "on" : "off"} groupDmChannels=${groupDmChannelSummary} groupPolicy=${params.groupPolicy} guilds=${guildSummary} historyLimit=${params.historyLimit} mediaMaxMb=${Math.round(params.mediaMaxBytes / (1024 * 1024))} native=${params.nativeEnabled ? "on" : "off"} nativeSkills=${params.nativeSkillsEnabled ? "on" : "off"} accessGroups=${params.useAccessGroups ? "on" : "off"} threadBindings=${params.threadBindingsEnabled ? "on" : "off"} threadIdleTimeout=${formatThreadBindingDurationForConfigLabel(params.threadBindingIdleTimeoutMs)} threadMaxAge=${formatThreadBindingDurationForConfigLabel(params.threadBindingMaxAgeMs)}`);
}
//#endregion
//#region extensions/discord/src/monitor/provider.deploy-errors.ts
const DISCORD_DEPLOY_REJECTED_ENTRY_LIMIT = 3;
function attachDiscordDeployRequestBody(err, body) {
	if (!err || typeof err !== "object" || body === void 0) return;
	const deployErr = err;
	if (deployErr.deployRequestBody === void 0) deployErr.deployRequestBody = body;
}
function attachDiscordDeployRestContext(err, context) {
	if (!err || typeof err !== "object") return;
	const deployErr = err;
	deployErr.deployRestMethod = context.method;
	deployErr.deployRestPath = context.path;
	deployErr.deployRequestMs = context.requestMs;
	if (typeof context.timeoutMs === "number" && Number.isFinite(context.timeoutMs)) deployErr.deployTimeoutMs = context.timeoutMs;
}
function stringifyDiscordDeployField(value) {
	if (typeof value === "string") return JSON.stringify(value);
	try {
		return JSON.stringify(value);
	} catch {
		return inspect(value, {
			depth: 2,
			breakLength: 120
		});
	}
}
function readDiscordDeployRejectedFields(value) {
	if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string").slice(0, 6);
	if (!value || typeof value !== "object") return [];
	return Object.keys(value).slice(0, 6);
}
function resolveDiscordRejectedDeployEntriesSource(rawBody) {
	if (!rawBody || typeof rawBody !== "object") return null;
	const payload = rawBody;
	const source = (payload.errors && typeof payload.errors === "object" ? payload.errors : void 0) ?? rawBody;
	return source && typeof source === "object" ? source : null;
}
function readDiscordDeployObjectField(value, field) {
	return value && typeof value === "object" && field in value ? value[field] : void 0;
}
function readFiniteNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
function formatDurationMs(ms) {
	return formatDurationSeconds(ms, { decimals: ms >= 1e3 ? 1 : 0 });
}
function isAbortLikeError(err) {
	if (!err || typeof err !== "object") return false;
	const name = "name" in err && typeof err.name === "string" ? err.name : void 0;
	const message = formatErrorMessage$1(err);
	return name === "AbortError" || message === "This operation was aborted" || message === "The operation was aborted" || /\boperation was aborted\b/i.test(message);
}
function formatDiscordDeployRestOperation(err) {
	const method = typeof err.deployRestMethod === "string" && err.deployRestMethod.trim().length > 0 ? err.deployRestMethod.toUpperCase() : void 0;
	const path = typeof err.deployRestPath === "string" && err.deployRestPath.trim().length > 0 ? err.deployRestPath : void 0;
	if (method && path) return `${method} ${path}`;
	if (method) return method;
	if (path) return path;
	return "request";
}
function formatDiscordDeployErrorMessage(err) {
	if (!isAbortLikeError(err)) return formatErrorMessage$1(err);
	const deployErr = err && typeof err === "object" ? err : {};
	const requestMs = readFiniteNumber(deployErr.deployRequestMs);
	const timeoutMs = readFiniteNumber(deployErr.deployTimeoutMs);
	const operation = formatDiscordDeployRestOperation(deployErr);
	if (!(requestMs !== void 0 || timeoutMs !== void 0 || deployErr.deployRestMethod !== void 0 || deployErr.deployRestPath !== void 0)) return "Discord REST request was aborted";
	const timing = [];
	if (timeoutMs !== void 0) timing.push(`timeout=${formatDurationMs(timeoutMs)}`);
	if (requestMs !== void 0) timing.push(`observed=${formatDurationMs(requestMs)}`);
	const timingText = timing.length > 0 ? ` (${timing.join(", ")})` : "";
	if (timeoutMs !== void 0 && requestMs !== void 0 && requestMs >= timeoutMs) return `Discord REST ${operation} timed out${timingText}`;
	return `Discord REST ${operation} was aborted${timingText}`;
}
function resolveDiscordDeployRateLimitDetails(err) {
	if (!err || typeof err !== "object") return;
	const deployErr = err;
	const status = readFiniteNumber(deployErr.status) ?? readFiniteNumber(deployErr.statusCode);
	const retryAfterSeconds = readFiniteNumber(deployErr.retryAfter) ?? readFiniteNumber(readDiscordDeployObjectField(deployErr.rawBody, "retry_after"));
	if (!(err instanceof RateLimitError || status === 429 || retryAfterSeconds !== void 0)) return;
	const rawGlobal = readDiscordDeployObjectField(deployErr.rawBody, "global");
	const scope = typeof deployErr.scope === "string" && deployErr.scope.trim().length > 0 ? deployErr.scope : rawGlobal === true ? "global" : rawGlobal === false ? "route" : void 0;
	const discordCode = typeof deployErr.discordCode === "number" || typeof deployErr.discordCode === "string" ? deployErr.discordCode : void 0;
	return {
		status,
		retryAfterMs: retryAfterSeconds === void 0 ? void 0 : Math.max(0, retryAfterSeconds * 1e3),
		scope,
		discordCode
	};
}
function formatDiscordDeployRateLimitDetails(err) {
	const rateLimit = resolveDiscordDeployRateLimitDetails(err);
	if (!rateLimit) return "";
	const details = [];
	if (typeof rateLimit.status === "number") details.push(`status=${rateLimit.status}`);
	if (typeof rateLimit.retryAfterMs === "number") details.push(`retryAfter=${formatDurationSeconds(rateLimit.retryAfterMs, { decimals: 1 })}`);
	if (rateLimit.scope) details.push(`scope=${rateLimit.scope}`);
	if (typeof rateLimit.discordCode === "number" || typeof rateLimit.discordCode === "string") details.push(`code=${rateLimit.discordCode}`);
	return details.length > 0 ? ` (${details.join(", ")})` : "";
}
function formatDiscordDeployRateLimitWarning(err, accountId) {
	const rateLimit = resolveDiscordDeployRateLimitDetails(err);
	if (!rateLimit) return;
	const parts = [`discord: native slash command deploy rate limited for ${accountId}`];
	if (typeof rateLimit.retryAfterMs === "number") parts.push(`retry after ${formatDurationSeconds(rateLimit.retryAfterMs, { decimals: 1 })}`);
	if (rateLimit.scope) parts.push(`scope=${rateLimit.scope}`);
	if (typeof rateLimit.discordCode === "number" || typeof rateLimit.discordCode === "string") parts.push(`code=${rateLimit.discordCode}`);
	return `${parts.join("; ")}. Existing slash commands stay active. Message send/receive is unaffected.`;
}
function formatDiscordRejectedDeployEntries(params) {
	const requestBody = Array.isArray(params.requestBody) ? params.requestBody : null;
	const rejectedEntriesSource = resolveDiscordRejectedDeployEntriesSource(params.rawBody);
	if (!rejectedEntriesSource || !requestBody || requestBody.length === 0) return [];
	return Object.entries(rejectedEntriesSource).filter(([key]) => /^\d+$/.test(key)).slice(0, DISCORD_DEPLOY_REJECTED_ENTRY_LIMIT).flatMap(([key, value]) => {
		const index = Number.parseInt(key, 10);
		if (!Number.isFinite(index) || index < 0 || index >= requestBody.length) return [];
		const command = requestBody[index];
		if (!command || typeof command !== "object") return [`#${index} fields=${readDiscordDeployRejectedFields(value).join("|") || "unknown"}`];
		const payload = command;
		const parts = [`#${index}`, `fields=${readDiscordDeployRejectedFields(value).join("|") || "unknown"}`];
		if (typeof payload.name === "string" && payload.name.trim().length > 0) parts.push(`name=${payload.name}`);
		if (payload.description !== void 0) parts.push(`description=${stringifyDiscordDeployField(payload.description)}`);
		if (Array.isArray(payload.options) && payload.options.length > 0) parts.push(`options=${payload.options.length}`);
		return [parts.join(" ")];
	});
}
function formatDiscordDeployErrorDetails(err) {
	if (!err || typeof err !== "object") return "";
	const rateLimitDetails = formatDiscordDeployRateLimitDetails(err);
	if (rateLimitDetails) return rateLimitDetails;
	const status = err.status;
	const discordCode = err.discordCode;
	const rawBody = err.rawBody;
	const requestBody = err.deployRequestBody;
	const details = [];
	if (typeof status === "number") details.push(`status=${status}`);
	if (typeof discordCode === "number" || typeof discordCode === "string") details.push(`code=${discordCode}`);
	if (rawBody !== void 0) {
		let bodyText = "";
		try {
			bodyText = JSON.stringify(rawBody);
		} catch {
			bodyText = typeof rawBody === "string" ? rawBody : inspect(rawBody, {
				depth: 3,
				breakLength: 120
			});
		}
		if (bodyText) {
			const maxLen = 800;
			const trimmed = bodyText.length > maxLen ? `${bodyText.slice(0, maxLen)}...` : bodyText;
			details.push(`body=${trimmed}`);
		}
	}
	const rejectedEntries = formatDiscordRejectedDeployEntries({
		rawBody,
		requestBody
	});
	if (rejectedEntries.length > 0) details.push(`rejected=${rejectedEntries.join("; ")}`);
	return details.length > 0 ? ` (${details.join(", ")})` : "";
}
function isDiscordDeployDailyCreateLimit(err) {
	if (!err || typeof err !== "object") return false;
	const deployErr = err;
	const discordCode = readFiniteNumber(deployErr.discordCode);
	const rawCode = readFiniteNumber(readDiscordDeployObjectField(deployErr.rawBody, "code"));
	return (discordCode === 30034 || rawCode === 30034) && /daily application command creates/i.test(formatErrorMessage$1(err));
}
//#endregion
//#region extensions/discord/src/monitor/provider.startup-log.ts
function formatDiscordStartupGatewayState(gateway) {
	if (!gateway) return "gateway=missing";
	const reconnectAttempts = gateway.reconnectAttempts;
	return `gatewayConnected=${gateway.isConnected ? "true" : "false"} reconnectAttempts=${typeof reconnectAttempts === "number" ? reconnectAttempts : "na"}`;
}
function logDiscordStartupPhase$1(params) {
	if (!(params.isVerbose ?? isVerbose)()) return;
	const elapsedMs = Math.max(0, Date.now() - params.startAt);
	const suffix = [params.details, formatDiscordStartupGatewayState(params.gateway)].filter((value) => Boolean(value)).join(" ");
	params.runtime.log?.(`discord startup [${params.accountId}] ${params.phase} ${elapsedMs}ms${suffix ? ` ${suffix}` : ""}`);
}
//#endregion
//#region extensions/discord/src/monitor/provider.deploy.ts
function readDeployRequestBody(data) {
	return data && typeof data === "object" && "body" in data ? data.body : void 0;
}
function wrapDeployRestMethod(params) {
	return async (path, data, query) => {
		const startedAt = Date.now();
		const body = readDeployRequestBody(data);
		const commandCount = Array.isArray(body) ? body.length : void 0;
		const bodyBytes = body === void 0 ? void 0 : Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body), "utf8");
		if (params.shouldLogVerbose()) params.runtime.log?.(`discord startup [${params.accountId}] native-slash-command-deploy-rest:${params.method}:start ${Math.max(0, Date.now() - params.startupStartedAt)}ms path=${path}${typeof commandCount === "number" ? ` commands=${commandCount}` : ""}${typeof bodyBytes === "number" ? ` bytes=${bodyBytes}` : ""}`);
		try {
			const result = await params.original[params.method](path, data, query);
			if (params.shouldLogVerbose()) params.runtime.log?.(`discord startup [${params.accountId}] native-slash-command-deploy-rest:${params.method}:done ${Math.max(0, Date.now() - params.startupStartedAt)}ms path=${path} requestMs=${Date.now() - startedAt}`);
			return result;
		} catch (err) {
			const requestMs = Date.now() - startedAt;
			attachDiscordDeployRequestBody(err, body);
			attachDiscordDeployRestContext(err, {
				method: params.method,
				path,
				requestMs,
				timeoutMs: params.timeoutMs
			});
			const rateLimitDetails = formatDiscordDeployRateLimitDetails(err);
			if (rateLimitDetails) {
				if (params.shouldLogVerbose()) params.runtime.log?.(warn(`discord startup [${params.accountId}] native-slash-command-deploy-rest:${params.method}:rate-limited ${Math.max(0, Date.now() - params.startupStartedAt)}ms path=${path} requestMs=${requestMs}${rateLimitDetails}`));
			} else {
				const details = formatDiscordDeployErrorDetails(err);
				params.runtime.error?.(`discord startup [${params.accountId}] native-slash-command-deploy-rest:${params.method}:error ${Math.max(0, Date.now() - params.startupStartedAt)}ms path=${path} requestMs=${requestMs} error=${formatDiscordDeployErrorMessage(err)}${details}`);
			}
			throw err;
		}
	};
}
function installDeployRestLogging(params) {
	const original = {
		get: params.rest.get.bind(params.rest),
		post: params.rest.post.bind(params.rest),
		put: params.rest.put.bind(params.rest),
		patch: params.rest.patch.bind(params.rest),
		delete: params.rest.delete.bind(params.rest)
	};
	for (const method of Object.keys(original)) {
		const timeout = params.rest.options?.timeout;
		params.rest[method] = wrapDeployRestMethod({
			method,
			original,
			runtime: params.runtime,
			accountId: params.accountId,
			startupStartedAt: params.startupStartedAt,
			timeoutMs: typeof timeout === "number" ? timeout : void 0,
			shouldLogVerbose: params.shouldLogVerbose
		});
	}
	return () => {
		params.rest.get = original.get;
		params.rest.post = original.post;
		params.rest.put = original.put;
		params.rest.patch = original.patch;
		params.rest.delete = original.delete;
	};
}
async function deployDiscordCommands(params) {
	if (!params.enabled) return;
	const startupStartedAt = params.startupStartedAt ?? Date.now();
	const accountId = params.accountId ?? "default";
	const restoreDeployRestLogging = installDeployRestLogging({
		rest: params.client.rest,
		runtime: params.runtime,
		accountId,
		startupStartedAt,
		shouldLogVerbose: params.shouldLogVerbose
	});
	try {
		try {
			await params.client.deployCommands({ mode: "reconcile" });
			return;
		} catch (err) {
			if (isDiscordDeployDailyCreateLimit(err)) {
				params.runtime.log?.(warn(`discord: native slash command deploy skipped for ${accountId}; daily application command create limit reached. Existing slash commands stay active until Discord resets the quota. Message send/receive is unaffected.`));
				return;
			}
			const rateLimitWarning = formatDiscordDeployRateLimitWarning(err, accountId);
			if (rateLimitWarning) {
				params.runtime.log?.(warn(rateLimitWarning));
				return;
			}
			throw err;
		}
	} catch (err) {
		params.runtime.log?.(warn(`discord: native slash command deploy warning (not message send): ${formatDiscordDeployErrorMessage(err)}${formatDiscordDeployErrorDetails(err)}`));
	} finally {
		restoreDeployRestLogging();
	}
}
function runDiscordCommandDeployInBackground(params) {
	if (!params.enabled) return;
	logDiscordStartupPhase$1({
		runtime: params.runtime,
		accountId: params.accountId,
		phase: "deploy-commands:scheduled",
		startAt: params.startupStartedAt,
		details: "mode=reconcile background=true",
		isVerbose: params.isVerbose
	});
	deployDiscordCommands(params).then(() => {
		logDiscordStartupPhase$1({
			runtime: params.runtime,
			accountId: params.accountId,
			phase: "deploy-commands:done",
			startAt: params.startupStartedAt,
			details: "background=true",
			isVerbose: params.isVerbose
		});
	}).catch((err) => {
		params.runtime.log?.(warn(`discord: native slash command deploy background warning (not message send): ${formatErrorMessage$1(err)}`));
	});
}
//#endregion
//#region extensions/discord/src/voice/command.ts
const VOICE_CHANNEL_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
async function authorizeVoiceCommand(interaction, params, options) {
	const channelOverride = options?.channelOverride;
	const channel = channelOverride ? void 0 : interaction.channel;
	if (!interaction.guild) return {
		ok: false,
		message: "Voice commands are only available in guilds."
	};
	const user = interaction.user;
	if (!user) return {
		ok: false,
		message: "Unable to resolve command user."
	};
	const channelId = channelOverride?.id ?? channel?.id ?? "";
	const channelContext = await resolveDiscordThreadLikeChannelContext({
		client: interaction.client,
		channel: channelOverride ?? channel,
		channelIdFallback: channelId
	});
	const channelName = channelOverride?.name ?? channelContext.channelName;
	const memberRoleIds = Array.isArray(interaction.rawData.member?.roles) ? interaction.rawData.member.roles.map((roleId) => roleId) : [];
	const sender = resolveDiscordSenderIdentity({
		author: user,
		member: interaction.rawData.member
	});
	const access = await authorizeDiscordVoiceIngress({
		cfg: params.cfg,
		discordConfig: params.discordConfig,
		groupPolicy: params.groupPolicy,
		useAccessGroups: params.useAccessGroups,
		guild: interaction.guild,
		guildId: interaction.guild.id,
		channelId,
		channelName,
		channelSlug: channelContext.channelSlug,
		parentId: channelOverride?.parentId ?? channelContext.threadParentId,
		parentName: channelContext.threadParentName,
		parentSlug: channelContext.threadParentSlug,
		scope: channelContext.isThreadChannel ? "thread" : "channel",
		channelLabel: channelId ? formatMention({ channelId }) : "This channel",
		memberRoleIds,
		ownerAllowFrom: resolveDiscordAccountAllowFrom({
			cfg: params.cfg,
			accountId: params.accountId
		}),
		sender: {
			id: sender.id,
			name: sender.name,
			tag: sender.tag
		}
	});
	if (!access.ok) return {
		ok: false,
		message: access.message
	};
	return {
		ok: true,
		guildId: interaction.guild.id
	};
}
async function resolveVoiceCommandRuntimeContext(interaction, params) {
	const guildId = interaction.guild?.id;
	if (!guildId) {
		await interaction.reply({
			content: "Unable to resolve guild for this command.",
			ephemeral: true
		});
		return null;
	}
	const manager = params.getManager();
	if (!manager) {
		await interaction.reply({
			content: "Voice manager is not available yet.",
			ephemeral: true
		});
		return null;
	}
	return {
		guildId,
		manager
	};
}
async function ensureVoiceCommandAccess(params) {
	const access = await authorizeVoiceCommand(params.interaction, params.context, { channelOverride: params.channelOverride });
	if (access.ok) return true;
	await params.interaction.reply({
		content: access.message ?? "Not authorized.",
		ephemeral: true
	});
	return false;
}
function createDiscordVoiceCommand(params) {
	const resolveSessionChannelId = (manager, guildId) => manager.status().find((entry) => entry.guildId === guildId)?.channelId;
	class JoinCommand extends Command {
		constructor(..._args) {
			super(..._args);
			this.name = "join";
			this.description = "Join a voice channel";
			this.defer = true;
			this.ephemeral = params.ephemeralDefault;
			this.options = [{
				name: "channel",
				description: "Voice channel to join",
				type: ApplicationCommandOptionType.Channel,
				required: true,
				channel_types: VOICE_CHANNEL_TYPES
			}];
		}
		async run(interaction) {
			const channel = await interaction.options.getChannel("channel", true);
			if (!channel || !("id" in channel)) {
				await interaction.reply({
					content: "Voice channel not found.",
					ephemeral: true
				});
				return;
			}
			const access = await authorizeVoiceCommand(interaction, params, { channelOverride: {
				id: channel.id,
				name: resolveDiscordChannelNameSafe(channel)
			} });
			if (!access.ok) {
				await interaction.reply({
					content: access.message ?? "Not authorized.",
					ephemeral: true
				});
				return;
			}
			if (!isVoiceChannelType(channel.type)) {
				await interaction.reply({
					content: "That is not a voice channel.",
					ephemeral: true
				});
				return;
			}
			const guildId = access.guildId ?? ("guildId" in channel ? channel.guildId : void 0);
			if (!guildId) {
				await interaction.reply({
					content: "Unable to resolve guild for this voice channel.",
					ephemeral: true
				});
				return;
			}
			const manager = params.getManager();
			if (!manager) {
				await interaction.reply({
					content: "Voice manager is not available yet.",
					ephemeral: true
				});
				return;
			}
			const result = await manager.join({
				guildId,
				channelId: channel.id
			});
			await interaction.reply({
				content: result.message,
				ephemeral: true
			});
		}
	}
	class LeaveCommand extends Command {
		constructor(..._args2) {
			super(..._args2);
			this.name = "leave";
			this.description = "Leave the current voice channel";
			this.defer = true;
			this.ephemeral = params.ephemeralDefault;
		}
		async run(interaction) {
			const runtimeContext = await resolveVoiceCommandRuntimeContext(interaction, params);
			if (!runtimeContext) return;
			const sessionChannelId = resolveSessionChannelId(runtimeContext.manager, runtimeContext.guildId);
			if (!await ensureVoiceCommandAccess({
				interaction,
				context: params,
				channelOverride: sessionChannelId ? { id: sessionChannelId } : void 0
			})) return;
			const result = await runtimeContext.manager.leave({ guildId: runtimeContext.guildId });
			await interaction.reply({
				content: result.message,
				ephemeral: true
			});
		}
	}
	class StatusCommand extends Command {
		constructor(..._args3) {
			super(..._args3);
			this.name = "status";
			this.description = "Show active voice sessions";
			this.defer = true;
			this.ephemeral = params.ephemeralDefault;
		}
		async run(interaction) {
			const runtimeContext = await resolveVoiceCommandRuntimeContext(interaction, params);
			if (!runtimeContext) return;
			const sessions = runtimeContext.manager.status().filter((entry) => entry.guildId === runtimeContext.guildId);
			const sessionChannelId = sessions[0]?.channelId;
			if (!await ensureVoiceCommandAccess({
				interaction,
				context: params,
				channelOverride: sessionChannelId ? { id: sessionChannelId } : void 0
			})) return;
			if (sessions.length === 0) {
				await interaction.reply({
					content: "No active voice sessions.",
					ephemeral: true
				});
				return;
			}
			const lines = sessions.map((entry) => `• ${formatMention({ channelId: entry.channelId })} (guild ${entry.guildId})`);
			await interaction.reply({
				content: lines.join("\n"),
				ephemeral: true
			});
		}
	}
	return new class extends CommandWithSubcommands {
		constructor(..._args4) {
			super(..._args4);
			this.name = "vc";
			this.description = "Voice channel controls";
			this.subcommands = [
				new JoinCommand(),
				new LeaveCommand(),
				new StatusCommand()
			];
		}
	}();
}
function isVoiceChannelType(type) {
	return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
}
//#endregion
//#region extensions/discord/src/monitor/agent-components-context.ts
function formatUsername(user) {
	if (user.discriminator && user.discriminator !== "0") return `${user.username}#${user.discriminator}`;
	return user.username;
}
function isThreadChannelType(channelType) {
	return channelType === ChannelType.PublicThread || channelType === ChannelType.PrivateThread || channelType === ChannelType.AnnouncementThread;
}
function resolveAgentComponentRoute(params) {
	return resolveAgentRoute({
		cfg: params.ctx.cfg,
		channel: "discord",
		accountId: params.ctx.accountId,
		guildId: params.rawGuildId,
		memberRoleIds: params.memberRoleIds,
		peer: {
			kind: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
			id: params.isDirectMessage ? params.userId : params.channelId
		},
		parentPeer: params.parentId ? {
			kind: "channel",
			id: params.parentId
		} : void 0
	});
}
async function ackComponentInteraction(params) {
	try {
		await params.interaction.reply({
			content: "✓",
			...params.replyOpts
		});
	} catch (err) {
		logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
	}
}
function resolveDiscordChannelContext(interaction) {
	const channel = interaction.channel;
	const channelInfo = resolveDiscordChannelInfoSafe(channel);
	const channelName = channelInfo.name;
	const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
	const displayChannelSlug = channelName ? normalizeDiscordDisplaySlug(channelName) : "";
	const channelType = channelInfo.type;
	const isThread = isThreadChannelType(channelType);
	let parentId;
	let parentName;
	let parentSlug = "";
	if (isThread) {
		parentId = channelInfo.parentId;
		parentName = channelInfo.parentName;
		if (parentName) parentSlug = normalizeDiscordSlug(parentName);
	}
	return {
		channelName,
		channelSlug,
		displayChannelSlug,
		channelType,
		isThread,
		parentId,
		parentName,
		parentSlug
	};
}
async function resolveComponentInteractionContext(params) {
	const { interaction, label } = params;
	const channelId = interaction.rawData.channel_id;
	if (!channelId) {
		logError(`${label}: missing channel_id in interaction`);
		return null;
	}
	const user = interaction.user;
	if (!user) {
		logError(`${label}: missing user in interaction`);
		return null;
	}
	const shouldDefer = params.defer !== false && "defer" in interaction;
	let didDefer = false;
	if (shouldDefer) try {
		await interaction.defer({ ephemeral: true });
		didDefer = true;
	} catch (err) {
		logError(`${label}: failed to defer interaction: ${String(err)}`);
	}
	const replyOpts = didDefer ? {} : { ephemeral: true };
	const username = formatUsername(user);
	const userId = user.id;
	const rawGuildId = interaction.rawData.guild_id;
	const channelType = resolveDiscordChannelContext(interaction).channelType;
	const isGroupDm = channelType === ChannelType.GroupDM;
	return {
		channelId,
		user,
		username,
		userId,
		replyOpts,
		rawGuildId,
		isDirectMessage: channelType === ChannelType.DM || !rawGuildId && !isGroupDm && channelType == null,
		isGroupDm,
		memberRoleIds: Array.isArray(interaction.rawData.member?.roles) ? interaction.rawData.member.roles.map((roleId) => roleId) : []
	};
}
//#endregion
//#region extensions/discord/src/monitor/agent-components-reply.ts
async function replySilently(interaction, params) {
	try {
		await interaction.reply(params);
	} catch {}
}
//#endregion
//#region extensions/discord/src/monitor/agent-components-dm-auth.ts
async function ensureDmComponentAuthorized(params) {
	const { ctx, interaction, user, componentLabel, replyOpts } = params;
	const allowFromPrefixes = [
		"discord:",
		"user:",
		"pk:"
	];
	const resolveAllowMatch = (entries) => {
		const allowList = normalizeDiscordAllowList(entries, allowFromPrefixes);
		return allowList ? resolveDiscordAllowListMatch({
			allowList,
			candidate: {
				id: user.id,
				name: user.username,
				tag: formatDiscordUserTag(user)
			},
			allowNameMatching: isDangerousNameMatchingEnabled(ctx.discordConfig)
		}) : { allowed: false };
	};
	const resolveAllowMatchWithAccessGroups = async (entries) => {
		const staticMatch = resolveAllowMatch(entries);
		if (staticMatch.allowed) return staticMatch;
		return (await resolveDiscordDmAccessGroupEntries({
			cfg: ctx.cfg,
			allowFrom: entries,
			sender: { id: user.id },
			accountId: ctx.accountId,
			token: ctx.token,
			isSenderAllowed: (senderId, allowFrom) => resolveAllowMatch(allowFrom).allowed || allowFrom.includes(senderId)
		})).length > 0 ? resolveAllowMatch([...entries, `discord:${user.id}`]) : staticMatch;
	};
	const dmPolicy = ctx.dmPolicy ?? "pairing";
	if (dmPolicy === "disabled") {
		logVerbose(`agent ${componentLabel}: blocked (DM policy disabled)`);
		await replySilently(interaction, {
			content: "DM interactions are disabled.",
			...replyOpts
		});
		return false;
	}
	if (dmPolicy === "allowlist") {
		if ((await resolveAllowMatchWithAccessGroups(ctx.allowFrom ?? [])).allowed) return true;
		logVerbose(`agent ${componentLabel}: blocked DM user ${user.id} (not in allowFrom)`);
		await replySilently(interaction, {
			content: `You are not authorized to use this ${componentLabel}.`,
			...replyOpts
		});
		return false;
	}
	const storeAllowFrom = dmPolicy === "open" ? [] : await readStoreAllowFromForDmPolicy$1({
		provider: "discord",
		accountId: ctx.accountId,
		dmPolicy
	});
	const allowMatch = resolveAllowMatch([...ctx.allowFrom ?? [], ...storeAllowFrom]);
	if ((allowMatch.allowed ? allowMatch : await resolveAllowMatchWithAccessGroups([...ctx.allowFrom ?? [], ...storeAllowFrom])).allowed) return true;
	if (dmPolicy === "pairing") {
		if (!(await createChannelPairingChallengeIssuer({
			channel: "discord",
			upsertPairingRequest: async ({ id, meta }) => {
				return await upsertChannelPairingRequest$1({
					channel: "discord",
					id,
					accountId: ctx.accountId,
					meta
				});
			}
		})({
			senderId: user.id,
			senderIdLine: `Your Discord user id: ${user.id}`,
			meta: {
				tag: formatDiscordUserTag(user),
				name: user.username
			},
			sendPairingReply: async (text) => {
				await interaction.reply({
					content: text,
					...replyOpts
				});
			}
		})).created) await replySilently(interaction, {
			content: "Pairing already requested. Ask the bot owner to approve your code.",
			...replyOpts
		});
		return false;
	}
	logVerbose(`agent ${componentLabel}: blocked DM user ${user.id} (not in allowFrom)`);
	await replySilently(interaction, {
		content: `You are not authorized to use this ${componentLabel}.`,
		...replyOpts
	});
	return false;
}
async function ensureGroupDmComponentAuthorized(params) {
	const { ctx, interaction, channelId, componentLabel, replyOpts } = params;
	if (!(ctx.discordConfig?.dm?.groupEnabled ?? false)) {
		logVerbose(`agent ${componentLabel}: blocked group dm ${channelId} (group DMs disabled)`);
		await replySilently(interaction, {
			content: "Group DM interactions are disabled.",
			...replyOpts
		});
		return false;
	}
	const channelCtx = resolveDiscordChannelContext(interaction);
	if (resolveGroupDmAllow({
		channels: ctx.discordConfig?.dm?.groupChannels,
		channelId,
		channelName: channelCtx.channelName,
		channelSlug: channelCtx.channelSlug
	})) return true;
	logVerbose(`agent ${componentLabel}: blocked group dm ${channelId} (not allowlisted)`);
	await replySilently(interaction, {
		content: `You are not authorized to use this ${componentLabel}.`,
		...replyOpts
	});
	return false;
}
async function resolveInteractionContextWithDmAuth(params) {
	const interactionCtx = await resolveComponentInteractionContext({
		interaction: params.interaction,
		label: params.label,
		defer: params.defer
	});
	if (!interactionCtx) return null;
	if (interactionCtx.isDirectMessage) {
		if (!await ensureDmComponentAuthorized({
			ctx: params.ctx,
			interaction: params.interaction,
			user: interactionCtx.user,
			componentLabel: params.componentLabel,
			replyOpts: interactionCtx.replyOpts
		})) return null;
	}
	if (interactionCtx.isGroupDm) {
		if (!await ensureGroupDmComponentAuthorized({
			ctx: params.ctx,
			interaction: params.interaction,
			channelId: interactionCtx.channelId,
			componentLabel: params.componentLabel,
			replyOpts: interactionCtx.replyOpts
		})) return null;
	}
	return interactionCtx;
}
//#endregion
//#region extensions/discord/src/monitor/agent-components-guild-auth.ts
function resolveComponentRuntimeGroupPolicy(ctx) {
	return resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: ctx.cfg.channels?.discord !== void 0,
		groupPolicy: ctx.discordConfig?.groupPolicy,
		defaultGroupPolicy: ctx.cfg.channels?.defaults?.groupPolicy
	}).groupPolicy;
}
async function ensureGuildComponentMemberAllowed(params) {
	const { interaction, guildInfo, channelId, rawGuildId, channelCtx, memberRoleIds, user, replyOpts, componentLabel, unauthorizedReply } = params;
	if (!rawGuildId) return true;
	const replyUnauthorized = async () => {
		await replySilently(interaction, {
			content: unauthorizedReply,
			...replyOpts
		});
	};
	const channelConfig = resolveDiscordChannelConfigWithFallback({
		guildInfo,
		channelId,
		channelName: channelCtx.channelName,
		channelSlug: channelCtx.channelSlug,
		parentId: channelCtx.parentId,
		parentName: channelCtx.parentName,
		parentSlug: channelCtx.parentSlug,
		scope: channelCtx.isThread ? "thread" : "channel"
	});
	if (channelConfig?.enabled === false) {
		await replyUnauthorized();
		return false;
	}
	const channelAllowlistConfigured = Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
	const channelAllowed = channelConfig?.allowed !== false;
	if (!isDiscordGroupAllowedByPolicy({
		groupPolicy: params.groupPolicy,
		guildAllowlisted: Boolean(guildInfo),
		channelAllowlistConfigured,
		channelAllowed
	})) {
		await replyUnauthorized();
		return false;
	}
	if (channelConfig?.allowed === false) {
		await replyUnauthorized();
		return false;
	}
	const { memberAllowed } = resolveDiscordMemberAccessState({
		channelConfig,
		guildInfo,
		memberRoleIds,
		sender: {
			id: user.id,
			name: user.username,
			tag: user.discriminator ? `${user.username}#${user.discriminator}` : void 0
		},
		allowNameMatching: params.allowNameMatching
	});
	if (memberAllowed) return true;
	logVerbose(`agent ${componentLabel}: blocked user ${user.id} (not in users/roles allowlist)`);
	await replyUnauthorized();
	return false;
}
async function ensureComponentUserAllowed(params) {
	const allowList = normalizeDiscordAllowList(params.entry.allowedUsers, [
		"discord:",
		"user:",
		"pk:"
	]);
	if (!allowList) return true;
	if (resolveDiscordAllowListMatch({
		allowList,
		candidate: {
			id: params.user.id,
			name: params.user.username,
			tag: formatDiscordUserTag(params.user)
		},
		allowNameMatching: params.allowNameMatching
	}).allowed) return true;
	logVerbose(`discord component ${params.componentLabel}: blocked user ${params.user.id} (not in allowedUsers)`);
	await replySilently(params.interaction, {
		content: params.unauthorizedReply,
		...params.replyOpts
	});
	return false;
}
async function ensureAgentComponentInteractionAllowed(params) {
	const guildInfo = resolveDiscordGuildEntry({
		guild: params.interaction.guild ?? void 0,
		guildId: params.rawGuildId,
		guildEntries: params.ctx.guildEntries
	});
	const channelCtx = resolveDiscordChannelContext(params.interaction);
	if (!await ensureGuildComponentMemberAllowed({
		interaction: params.interaction,
		guildInfo,
		channelId: params.channelId,
		rawGuildId: params.rawGuildId,
		channelCtx,
		memberRoleIds: params.memberRoleIds,
		user: params.user,
		replyOpts: params.replyOpts,
		componentLabel: params.componentLabel,
		unauthorizedReply: params.unauthorizedReply,
		allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig),
		groupPolicy: resolveComponentRuntimeGroupPolicy(params.ctx)
	})) return null;
	return { parentId: channelCtx.parentId };
}
async function resolveAuthorizedComponentInteraction(params) {
	const interactionCtx = await resolveInteractionContextWithDmAuth({
		ctx: params.ctx,
		interaction: params.interaction,
		label: params.label,
		componentLabel: params.componentLabel,
		defer: params.defer
	});
	if (!interactionCtx) return null;
	const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
	const guildInfo = resolveDiscordGuildEntry({
		guild: params.interaction.guild ?? void 0,
		guildId: rawGuildId,
		guildEntries: params.ctx.guildEntries
	});
	const channelCtx = resolveDiscordChannelContext(params.interaction);
	const allowNameMatching = isDangerousNameMatchingEnabled(params.ctx.discordConfig);
	const channelConfig = resolveDiscordChannelConfigWithFallback({
		guildInfo,
		channelId,
		channelName: channelCtx.channelName,
		channelSlug: channelCtx.channelSlug,
		parentId: channelCtx.parentId,
		parentName: channelCtx.parentName,
		parentSlug: channelCtx.parentSlug,
		scope: channelCtx.isThread ? "thread" : "channel"
	});
	if (!await ensureGuildComponentMemberAllowed({
		interaction: params.interaction,
		guildInfo,
		channelId,
		rawGuildId,
		channelCtx,
		memberRoleIds,
		user,
		replyOpts,
		componentLabel: params.componentLabel,
		unauthorizedReply: params.unauthorizedReply,
		allowNameMatching,
		groupPolicy: resolveComponentRuntimeGroupPolicy(params.ctx)
	})) return null;
	return {
		interactionCtx,
		channelCtx,
		guildInfo,
		channelConfig,
		allowNameMatching,
		commandAuthorized: resolveComponentCommandAuthorized({
			ctx: params.ctx,
			interactionCtx,
			channelConfig,
			guildInfo,
			allowNameMatching
		}),
		user,
		replyOpts
	};
}
function resolveComponentCommandAuthorized(params) {
	const { ctx, interactionCtx, channelConfig, guildInfo } = params;
	if (interactionCtx.isDirectMessage) return true;
	const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
		allowFrom: ctx.allowFrom,
		sender: {
			id: interactionCtx.user.id,
			name: interactionCtx.user.username,
			tag: formatDiscordUserTag(interactionCtx.user)
		},
		allowNameMatching: params.allowNameMatching
	});
	const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
		channelConfig,
		guildInfo,
		memberRoleIds: interactionCtx.memberRoleIds,
		sender: {
			id: interactionCtx.user.id,
			name: interactionCtx.user.username,
			tag: formatDiscordUserTag(interactionCtx.user)
		},
		allowNameMatching: params.allowNameMatching
	});
	const useAccessGroups = ctx.cfg.commands?.useAccessGroups !== false;
	return resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups,
		authorizers: useAccessGroups ? [{
			configured: ownerAllowList != null,
			allowed: ownerOk
		}, {
			configured: hasAccessRestrictions,
			allowed: memberAllowed
		}] : [{
			configured: hasAccessRestrictions,
			allowed: memberAllowed
		}],
		modeWhenAccessGroupsOff: "configured"
	});
}
//#endregion
//#region extensions/discord/src/monitor/agent-components-data.ts
function readParsedComponentId(data) {
	if (!data || typeof data !== "object") return;
	return "cid" in data ? data.cid : data.componentId;
}
function normalizeComponentId(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : void 0;
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
}
function mapOptionLabels(options, values) {
	if (!options || options.length === 0) return values;
	const map = new Map(options.map((option) => [option.value, option.label]));
	return values.map((value) => map.get(value) ?? value);
}
function parseAgentComponentData(data) {
	const raw = readParsedComponentId(data);
	const decodeSafe = (value) => {
		if (!value.includes("%")) return value;
		if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	};
	const componentId = typeof raw === "string" ? decodeSafe(raw) : typeof raw === "number" ? String(raw) : null;
	if (!componentId) return null;
	return { componentId };
}
function parseDiscordComponentData(data, customId) {
	if (!data || typeof data !== "object") return null;
	const rawComponentId = readParsedComponentId(data);
	const rawModalId = "mid" in data ? data.mid : data.modalId;
	let componentId = normalizeComponentId(rawComponentId);
	let modalId = normalizeComponentId(rawModalId);
	if (!componentId && customId) {
		const parsed = parseDiscordComponentCustomId(customId);
		if (parsed) {
			componentId = parsed.componentId;
			modalId = parsed.modalId;
		}
	}
	if (!componentId) return null;
	return {
		componentId,
		modalId
	};
}
function parseDiscordModalId(data, customId) {
	if (data && typeof data === "object") {
		const modalId = normalizeComponentId("mid" in data ? data.mid : data.modalId);
		if (modalId) return modalId;
	}
	if (customId) return parseDiscordModalCustomId(customId);
	return null;
}
function resolveInteractionCustomId(interaction) {
	if (!interaction?.rawData || typeof interaction.rawData !== "object") return;
	if (!("data" in interaction.rawData)) return;
	const customId = interaction.rawData.data?.custom_id;
	if (typeof customId !== "string") return;
	const trimmed = customId.trim();
	return trimmed ? trimmed : void 0;
}
function mapSelectValues(entry, values) {
	if (entry.selectType === "string") return mapOptionLabels(entry.options, values);
	if (entry.selectType === "user") return values.map((value) => `user:${value}`);
	if (entry.selectType === "role") return values.map((value) => `role:${value}`);
	if (entry.selectType === "mentionable") return values.map((value) => `mentionable:${value}`);
	if (entry.selectType === "channel") return values.map((value) => `channel:${value}`);
	return values;
}
function resolveModalFieldValues(field, interaction) {
	const fields = interaction.fields;
	const optionLabels = field.options?.map((option) => ({
		value: option.value,
		label: option.label
	}));
	const required = field.required === true;
	try {
		switch (field.type) {
			case "text": {
				const value = required ? fields.getText(field.id, true) : fields.getText(field.id);
				return value ? [value] : [];
			}
			case "select":
			case "checkbox":
			case "radio": return mapOptionLabels(optionLabels, required ? fields.getStringSelect(field.id, true) : fields.getStringSelect(field.id) ?? []);
			case "role-select": try {
				return (required ? fields.getRoleSelect(field.id, true) : fields.getRoleSelect(field.id) ?? []).map((role) => role.name ?? role.id);
			} catch {
				return required ? fields.getStringSelect(field.id, true) : fields.getStringSelect(field.id) ?? [];
			}
			case "user-select": return (required ? fields.getUserSelect(field.id, true) : fields.getUserSelect(field.id) ?? []).map((user) => formatDiscordUserTag(user));
			default: return [];
		}
	} catch (err) {
		logError(`agent modal: failed to read field ${field.id}: ${String(err)}`);
		return [];
	}
}
function formatModalSubmissionText(entry, interaction) {
	const lines = [`Form "${entry.title}" submitted.`];
	for (const field of entry.fields) {
		const values = resolveModalFieldValues(field, interaction);
		if (values.length === 0) continue;
		lines.push(`- ${field.label}: ${values.join(", ")}`);
	}
	if (lines.length === 1) lines.push("- (no values)");
	return lines.join("\n");
}
function resolveDiscordInteractionId(interaction) {
	const rawId = interaction.rawData && typeof interaction.rawData === "object" && "id" in interaction.rawData ? interaction.rawData.id : void 0;
	if (typeof rawId === "string" && rawId.trim()) return rawId.trim();
	if (typeof rawId === "number" && Number.isFinite(rawId)) return String(rawId);
	return `discord-interaction:${Date.now()}`;
}
//#endregion
//#region extensions/discord/src/monitor/agent-components-helpers.ts
const AGENT_BUTTON_KEY = "agent";
const AGENT_SELECT_KEY = "agentsel";
//#endregion
//#region extensions/discord/src/monitor/agent-components.dispatch.ts
let conversationRuntimePromise$1;
let replyPipelineRuntimePromise;
let typingRuntimePromise;
async function loadConversationRuntime$1() {
	conversationRuntimePromise$1 ??= import("./agent-components.runtime-DUhLr9hy.js");
	return await conversationRuntimePromise$1;
}
async function loadReplyPipelineRuntime() {
	replyPipelineRuntimePromise ??= import("openclaw/plugin-sdk/channel-reply-pipeline");
	return await replyPipelineRuntimePromise;
}
async function loadTypingRuntime() {
	typingRuntimePromise ??= import("./typing-BSi1dUHm.js").then((n) => n.n);
	return await typingRuntimePromise;
}
function buildDiscordComponentConversationLabel(params) {
	if (params.interactionCtx.isDirectMessage) return buildDirectLabel(params.interactionCtx.user);
	if (params.interactionCtx.isGroupDm) return `Group DM #${params.channelCtx.channelName ?? params.interactionCtx.channelId} channel id:${params.interactionCtx.channelId}`;
	return buildGuildLabel({
		guild: params.interaction.guild ?? void 0,
		channelName: params.channelCtx.channelName ?? params.interactionCtx.channelId,
		channelId: params.interactionCtx.channelId
	});
}
function resolveDiscordComponentChatType(interactionCtx) {
	if (interactionCtx.isDirectMessage) return "direct";
	if (interactionCtx.isGroupDm) return "group";
	return "channel";
}
function resolveDiscordComponentOriginatingTo(interactionCtx) {
	return resolveDiscordConversationIdentity({
		isDirectMessage: interactionCtx.isDirectMessage,
		userId: interactionCtx.userId,
		channelId: interactionCtx.channelId
	});
}
async function dispatchDiscordComponentEvent(params) {
	const { ctx, interaction, interactionCtx, channelCtx, guildInfo, eventText } = params;
	const runtime = ctx.runtime ?? createNonExitingRuntime();
	const route = resolveAgentComponentRoute({
		ctx,
		rawGuildId: interactionCtx.rawGuildId,
		memberRoleIds: interactionCtx.memberRoleIds,
		isDirectMessage: interactionCtx.isDirectMessage,
		isGroupDm: interactionCtx.isGroupDm,
		userId: interactionCtx.userId,
		channelId: interactionCtx.channelId,
		parentId: channelCtx.parentId
	});
	const sessionKey = params.routeOverrides?.sessionKey ?? route.sessionKey;
	const agentId = params.routeOverrides?.agentId ?? route.agentId;
	const accountId = params.routeOverrides?.accountId ?? route.accountId;
	const fromLabel = buildDiscordComponentConversationLabel({
		interactionCtx,
		interaction,
		channelCtx
	});
	const chatType = resolveDiscordComponentChatType(interactionCtx);
	const senderName = interactionCtx.user.globalName ?? interactionCtx.user.username;
	const senderUsername = interactionCtx.user.username;
	const senderTag = formatDiscordUserTag(interactionCtx.user);
	const groupChannel = !interactionCtx.isDirectMessage && channelCtx.displayChannelSlug ? `#${channelCtx.displayChannelSlug}` : void 0;
	const groupSubject = interactionCtx.isDirectMessage ? void 0 : groupChannel;
	const channelConfig = resolveDiscordChannelConfigWithFallback({
		guildInfo,
		channelId: interactionCtx.channelId,
		channelName: channelCtx.channelName,
		channelSlug: channelCtx.channelSlug,
		parentId: channelCtx.parentId,
		parentName: channelCtx.parentName,
		parentSlug: channelCtx.parentSlug,
		scope: channelCtx.isThread ? "thread" : "channel"
	});
	const allowNameMatching = isDangerousNameMatchingEnabled(ctx.discordConfig);
	const { ownerAllowFrom } = buildDiscordInboundAccessContext({
		channelConfig,
		guildInfo,
		sender: {
			id: interactionCtx.user.id,
			name: interactionCtx.user.username,
			tag: senderTag
		},
		allowNameMatching,
		isGuild: !interactionCtx.isDirectMessage
	});
	const groupSystemPrompt = buildDiscordGroupSystemPrompt(channelConfig);
	const pinnedMainDmOwner = interactionCtx.isDirectMessage ? resolvePinnedMainDmOwnerFromAllowlist$1({
		dmScope: ctx.cfg.session?.dmScope,
		allowFrom: channelConfig?.users ?? guildInfo?.users,
		normalizeEntry: (entry) => {
			const candidate = normalizeDiscordAllowList([entry], [
				"discord:",
				"user:",
				"pk:"
			])?.ids.values().next().value;
			return typeof candidate === "string" && /^\d+$/.test(candidate) ? candidate : void 0;
		}
	}) : null;
	const commandAuthorized = resolveComponentCommandAuthorized({
		ctx,
		interactionCtx,
		channelConfig,
		guildInfo,
		allowNameMatching
	});
	const storePath = resolveStorePath$1(ctx.cfg.session?.store, { agentId });
	const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
	const previousTimestamp = readSessionUpdatedAt$1({
		storePath,
		sessionKey
	});
	const timestamp = Date.now();
	const combinedBody = formatInboundEnvelope({
		channel: "Discord",
		from: fromLabel,
		timestamp,
		body: eventText,
		chatType,
		senderLabel: senderName,
		previousTimestamp,
		envelope: envelopeOptions
	});
	const { createReplyReferencePlanner, dispatchReplyWithBufferedBlockDispatcher, finalizeInboundContext, resolveChunkMode, resolveTextChunkLimit, recordInboundSession } = await (async () => {
		return { ...await loadConversationRuntime$1() };
	})();
	const ctxPayload = finalizeInboundContext({
		Body: combinedBody,
		BodyForAgent: eventText,
		RawBody: eventText,
		CommandBody: eventText,
		From: interactionCtx.isDirectMessage ? `discord:${interactionCtx.userId}` : interactionCtx.isGroupDm ? `discord:group:${interactionCtx.channelId}` : `discord:channel:${interactionCtx.channelId}`,
		To: `channel:${interactionCtx.channelId}`,
		SessionKey: sessionKey,
		AccountId: accountId,
		ChatType: chatType,
		ConversationLabel: fromLabel,
		SenderName: senderName,
		SenderId: interactionCtx.userId,
		SenderUsername: senderUsername,
		SenderTag: senderTag,
		GroupSubject: groupSubject,
		GroupChannel: groupChannel,
		MemberRoleIds: interactionCtx.memberRoleIds,
		GroupSystemPrompt: interactionCtx.isDirectMessage ? void 0 : groupSystemPrompt,
		GroupSpace: guildInfo?.id ?? guildInfo?.slug ?? interactionCtx.rawGuildId ?? void 0,
		OwnerAllowFrom: ownerAllowFrom,
		Provider: "discord",
		Surface: "discord",
		WasMentioned: true,
		CommandAuthorized: commandAuthorized,
		CommandSource: "text",
		MessageSid: interaction.rawData.id,
		Timestamp: timestamp,
		OriginatingChannel: "discord",
		OriginatingTo: resolveDiscordComponentOriginatingTo(interactionCtx) ?? `channel:${interactionCtx.channelId}`
	});
	const deliverTarget = `channel:${interactionCtx.channelId}`;
	const typingChannelId = interactionCtx.channelId;
	const { createChannelReplyPipeline } = await loadReplyPipelineRuntime();
	const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
		cfg: ctx.cfg,
		agentId,
		channel: "discord",
		accountId
	});
	const tableMode = resolveMarkdownTableMode({
		cfg: ctx.cfg,
		channel: "discord",
		accountId
	});
	const textLimit = resolveTextChunkLimit(ctx.cfg, "discord", accountId, { fallbackLimit: 2e3 });
	const token = ctx.token ?? "";
	const feedbackRest = createDiscordRestClient({
		cfg: ctx.cfg,
		token,
		accountId
	}).rest;
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(ctx.cfg, agentId);
	const replyToMode = ctx.discordConfig?.replyToMode ?? ctx.cfg.channels?.discord?.replyToMode ?? "off";
	const replyReference = createReplyReferencePlanner({
		replyToMode,
		startId: params.replyToId
	});
	await runInboundReplyTurn({
		channel: "discord",
		accountId,
		raw: interaction,
		adapter: {
			ingest: () => ({
				id: interaction.id,
				rawText: ctxPayload.RawBody ?? "",
				textForAgent: ctxPayload.BodyForAgent,
				textForCommands: ctxPayload.CommandBody,
				raw: interaction
			}),
			resolveTurn: () => ({
				channel: "discord",
				accountId,
				routeSessionKey: sessionKey,
				storePath,
				ctxPayload,
				recordInboundSession,
				record: {
					updateLastRoute: interactionCtx.isDirectMessage ? {
						sessionKey: route.mainSessionKey,
						channel: "discord",
						to: resolveDiscordComponentOriginatingTo(interactionCtx) ?? `user:${interactionCtx.userId}`,
						accountId,
						mainDmOwnerPin: pinnedMainDmOwner ? {
							ownerRecipient: pinnedMainDmOwner,
							senderRecipient: interactionCtx.userId,
							onSkip: ({ ownerRecipient, senderRecipient }) => {
								logVerbose(`discord: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`);
							}
						} : void 0
					} : void 0,
					onRecordError: (err) => {
						logVerbose(`discord: failed updating component session meta: ${String(err)}`);
					}
				},
				runDispatch: () => dispatchReplyWithBufferedBlockDispatcher({
					ctx: ctxPayload,
					cfg: ctx.cfg,
					replyOptions: { onModelSelected },
					dispatcherOptions: {
						...replyPipeline,
						humanDelay: resolveHumanDelayConfig(ctx.cfg, agentId),
						deliver: async (payload) => {
							const replyToId = replyReference.use();
							await deliverDiscordReply({
								cfg: ctx.cfg,
								replies: [payload],
								target: deliverTarget,
								token,
								accountId,
								rest: interaction.client.rest,
								runtime,
								replyToId,
								replyToMode,
								textLimit,
								maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
									cfg: ctx.cfg,
									discordConfig: ctx.discordConfig,
									accountId
								}),
								tableMode,
								chunkMode: resolveChunkMode(ctx.cfg, "discord", accountId),
								mediaLocalRoots
							});
							replyReference.markSent();
						},
						onReplyStart: async () => {
							try {
								const { sendTyping } = await loadTypingRuntime();
								await sendTyping({
									rest: feedbackRest,
									channelId: typingChannelId
								});
							} catch (err) {
								logVerbose(`discord: typing failed for component reply: ${String(err)}`);
							}
						},
						onError: (err) => {
							logError(`discord component dispatch failed: ${String(err)}`);
						}
					}
				})
			})
		}
	});
}
//#endregion
//#region extensions/discord/src/interactive-dispatch.ts
async function dispatchDiscordPluginInteractiveHandler(params) {
	return await dispatchPluginInteractiveHandler({
		channel: "discord",
		data: params.data,
		dedupeId: params.interactionId,
		onMatched: params.onMatched,
		invoke: ({ registration, namespace, payload }) => registration.handler({
			...params.ctx,
			channel: "discord",
			interaction: {
				...params.ctx.interaction,
				data: params.data,
				namespace,
				payload
			},
			respond: params.respond,
			...createInteractiveConversationBindingHelpers({
				registration,
				senderId: params.ctx.senderId,
				conversation: {
					channel: "discord",
					accountId: params.ctx.accountId,
					conversationId: params.ctx.conversationId,
					parentConversationId: params.ctx.parentConversationId
				}
			})
		})
	});
}
//#endregion
//#region extensions/discord/src/monitor/agent-components.plugin-interactive.ts
let conversationRuntimePromise;
async function loadConversationRuntime() {
	conversationRuntimePromise ??= import("./agent-components.runtime-DUhLr9hy.js");
	return await conversationRuntimePromise;
}
async function dispatchPluginDiscordInteractiveEvent(params) {
	const normalizedConversationId = params.interactionCtx.rawGuildId || params.channelCtx.channelType === ChannelType.GroupDM ? `channel:${params.interactionCtx.channelId}` : `user:${params.interactionCtx.userId}`;
	let responded = false;
	let acknowledged = false;
	const updateOriginalMessage = async (input) => {
		const payload = {
			...input.text !== void 0 ? { content: input.text } : {},
			...input.components !== void 0 ? { components: input.components } : {}
		};
		if (acknowledged) {
			await params.interaction.reply(payload);
			return;
		}
		if (!("update" in params.interaction) || typeof params.interaction.update !== "function") throw new Error("Discord interaction cannot update the source message");
		await params.interaction.update(payload);
	};
	const respond = {
		acknowledge: async () => {
			if (responded) return;
			await params.interaction.acknowledge();
			acknowledged = true;
			responded = true;
		},
		reply: async ({ text, ephemeral = true }) => {
			responded = true;
			await params.interaction.reply({
				content: text,
				ephemeral
			});
		},
		followUp: async ({ text, ephemeral = true }) => {
			responded = true;
			await params.interaction.followUp({
				content: text,
				ephemeral
			});
		},
		editMessage: async (input) => {
			const { text, components } = input;
			responded = true;
			await updateOriginalMessage({
				text,
				components
			});
		},
		clearComponents: async (input) => {
			responded = true;
			await updateOriginalMessage({
				text: input?.text,
				components: []
			});
		}
	};
	const conversationRuntime = await loadConversationRuntime();
	const pluginBindingApproval = conversationRuntime.parsePluginBindingApprovalCustomId(params.data);
	if (pluginBindingApproval) {
		const { buildPluginBindingResolvedText, resolvePluginConversationBindingApproval } = conversationRuntime;
		try {
			await respond.acknowledge();
		} catch {}
		const resolved = await resolvePluginConversationBindingApproval({
			approvalId: pluginBindingApproval.approvalId,
			decision: pluginBindingApproval.decision,
			senderId: params.interactionCtx.userId
		});
		const approvalMessageId = params.messageId?.trim() || params.interaction.message?.id?.trim();
		if (approvalMessageId) try {
			await editDiscordComponentMessage(normalizedConversationId, approvalMessageId, { text: buildPluginBindingResolvedText(resolved) }, {
				cfg: params.ctx.cfg,
				accountId: params.ctx.accountId
			});
		} catch (err) {
			logError(`discord plugin binding approval: failed to clear prompt: ${String(err)}`);
		}
		if (resolved.status !== "approved") try {
			await respond.followUp({
				text: buildPluginBindingResolvedText(resolved),
				ephemeral: true
			});
		} catch (err) {
			logError(`discord plugin binding approval: failed to follow up: ${String(err)}`);
		}
		return "handled";
	}
	const dispatched = await dispatchDiscordPluginInteractiveHandler({
		data: params.data,
		interactionId: resolveDiscordInteractionId(params.interaction),
		ctx: {
			accountId: params.ctx.accountId,
			interactionId: resolveDiscordInteractionId(params.interaction),
			conversationId: normalizedConversationId,
			parentConversationId: params.channelCtx.parentId,
			guildId: params.interactionCtx.rawGuildId,
			senderId: params.interactionCtx.userId,
			senderUsername: params.interactionCtx.username,
			auth: { isAuthorizedSender: params.isAuthorizedSender },
			interaction: {
				kind: params.kind,
				messageId: params.messageId,
				values: params.values,
				fields: params.fields
			}
		},
		respond,
		onMatched: async () => {
			try {
				await respond.acknowledge();
			} catch {}
		}
	});
	if (!dispatched.matched) return "unmatched";
	if (dispatched.handled) {
		if (!responded) try {
			await respond.acknowledge();
		} catch {}
		return "handled";
	}
	return "unmatched";
}
//#endregion
//#region extensions/discord/src/monitor/agent-components.handlers.ts
let componentsRuntimePromise;
async function loadComponentsRuntime() {
	componentsRuntimePromise ??= import("./components-D5LnN7ZQ.js").then((n) => n.t);
	return await componentsRuntimePromise;
}
async function handleDiscordComponentEvent(params) {
	const parsed = parseDiscordComponentData(params.data, resolveInteractionCustomId(params.interaction));
	if (!parsed) {
		logError(`${params.label}: failed to parse component data`);
		try {
			await params.interaction.reply({
				content: "This component is no longer valid.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const entry = await resolveDiscordComponentEntryWithPersistence({
		id: parsed.componentId,
		consume: false
	});
	if (!entry) {
		try {
			await params.interaction.reply({
				content: "This component has expired.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const unauthorizedReply = `You are not authorized to use this ${params.componentLabel}.`;
	const authorized = await resolveAuthorizedComponentInteraction({
		ctx: params.ctx,
		interaction: params.interaction,
		label: params.label,
		componentLabel: params.componentLabel,
		unauthorizedReply,
		defer: false
	});
	if (!authorized) return;
	const { interactionCtx, channelCtx, guildInfo, allowNameMatching, commandAuthorized, user, replyOpts } = authorized;
	if (!await ensureComponentUserAllowed({
		entry,
		interaction: params.interaction,
		user,
		replyOpts,
		componentLabel: params.componentLabel,
		unauthorizedReply,
		allowNameMatching
	})) return;
	const consumed = await resolveDiscordComponentEntryWithPersistence({
		id: parsed.componentId,
		consume: !entry.reusable
	});
	if (!consumed) {
		try {
			await params.interaction.reply({
				content: "This component has expired.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	if (consumed.kind === "modal-trigger") {
		try {
			await params.interaction.reply({
				content: "This form is no longer available.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const values = params.values ? mapSelectValues(consumed, params.values) : void 0;
	if (consumed.callbackData) {
		if (await dispatchPluginDiscordInteractiveEvent({
			ctx: params.ctx,
			interaction: params.interaction,
			interactionCtx,
			channelCtx,
			isAuthorizedSender: commandAuthorized,
			data: consumed.callbackData,
			kind: consumed.kind === "select" ? "select" : "button",
			values,
			messageId: consumed.messageId ?? params.interaction.message?.id
		}) === "handled") return;
	}
	const eventText = (consumed.kind === "button" ? consumed.callbackData?.trim() : void 0) || (await loadComponentsRuntime()).formatDiscordComponentEventText({
		kind: consumed.kind === "select" ? "select" : "button",
		label: consumed.label,
		values
	});
	try {
		await params.interaction.reply({
			content: "✓",
			...replyOpts
		});
	} catch (err) {
		logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
	}
	await dispatchDiscordComponentEvent({
		ctx: params.ctx,
		interaction: params.interaction,
		interactionCtx,
		channelCtx,
		guildInfo,
		eventText,
		replyToId: consumed.messageId ?? params.interaction.message?.id,
		routeOverrides: {
			sessionKey: consumed.sessionKey,
			agentId: consumed.agentId,
			accountId: consumed.accountId
		}
	});
}
async function handleDiscordModalTrigger(params) {
	const parsed = parseDiscordComponentData(params.data, resolveInteractionCustomId(params.interaction));
	if (!parsed) {
		logError(`${params.label}: failed to parse modal trigger data`);
		try {
			await params.interaction.reply({
				content: "This button is no longer valid.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const entry = await resolveDiscordComponentEntryWithPersistence({
		id: parsed.componentId,
		consume: false
	});
	if (!entry || entry.kind !== "modal-trigger") {
		try {
			await params.interaction.reply({
				content: "This button has expired.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const modalId = entry.modalId ?? parsed.modalId;
	if (!modalId) {
		try {
			await params.interaction.reply({
				content: "This form is no longer available.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const unauthorizedReply = "You are not authorized to use this form.";
	const authorized = await resolveAuthorizedComponentInteraction({
		ctx: params.ctx,
		interaction: params.interaction,
		label: params.label,
		componentLabel: "form",
		unauthorizedReply,
		defer: false
	});
	if (!authorized) return;
	const { user, replyOpts, allowNameMatching } = authorized;
	if (!await ensureComponentUserAllowed({
		entry,
		interaction: params.interaction,
		user,
		replyOpts,
		componentLabel: "form",
		unauthorizedReply,
		allowNameMatching
	})) return;
	const consumed = await resolveDiscordComponentEntryWithPersistence({
		id: parsed.componentId,
		consume: !entry.reusable
	});
	if (!consumed) {
		try {
			await params.interaction.reply({
				content: "This form has expired.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const modalEntry = await resolveDiscordModalEntryWithPersistence({
		id: consumed.modalId ?? modalId,
		consume: false
	});
	if (!modalEntry) {
		try {
			await params.interaction.reply({
				content: "This form has expired.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	try {
		await params.interaction.showModal((await loadComponentsRuntime()).createDiscordFormModal(modalEntry));
	} catch (err) {
		logError(`${params.label}: failed to show modal: ${String(err)}`);
	}
}
const discordComponentControlHandlers = {
	handleComponentEvent: handleDiscordComponentEvent,
	handleModalTrigger: handleDiscordModalTrigger
};
//#endregion
//#region extensions/discord/src/monitor/agent-components.modal.ts
var DiscordComponentModal = class extends Modal {
	constructor(ctx) {
		super();
		this.title = "OpenClaw form";
		this.customId = "__openclaw_discord_component_modal_wildcard__";
		this.components = [];
		this.customIdParser = parseDiscordModalCustomIdForInteraction;
		this.ctx = ctx;
	}
	async run(interaction, data) {
		const modalId = parseDiscordModalId(data, resolveInteractionCustomId(interaction));
		if (!modalId) {
			logError("discord component modal: missing modal id");
			try {
				await interaction.reply({
					content: "This form is no longer valid.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		const modalEntry = await resolveDiscordModalEntryWithPersistence({
			id: modalId,
			consume: false
		});
		if (!modalEntry) {
			try {
				await interaction.reply({
					content: "This form has expired.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		const unauthorizedReply = "You are not authorized to use this form.";
		const authorized = await resolveAuthorizedComponentInteraction({
			ctx: this.ctx,
			interaction,
			label: "discord component modal",
			componentLabel: "form",
			unauthorizedReply,
			defer: false
		});
		if (!authorized) return;
		const { interactionCtx, channelCtx, guildInfo, allowNameMatching, commandAuthorized, user, replyOpts } = authorized;
		if (!await ensureComponentUserAllowed({
			entry: {
				id: modalEntry.id,
				kind: "button",
				label: modalEntry.title,
				allowedUsers: modalEntry.allowedUsers
			},
			interaction,
			user,
			replyOpts,
			componentLabel: "form",
			unauthorizedReply,
			allowNameMatching
		})) return;
		const consumed = await resolveDiscordModalEntryWithPersistence({
			id: modalId,
			consume: !modalEntry.reusable
		});
		if (!consumed) {
			try {
				await interaction.reply({
					content: "This form has expired.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		if (consumed.callbackData) {
			const fields = consumed.fields.map((field) => ({
				id: field.id,
				name: field.name,
				values: resolveModalFieldValues(field, interaction)
			}));
			if (await dispatchPluginDiscordInteractiveEvent({
				ctx: this.ctx,
				interaction,
				interactionCtx,
				channelCtx,
				isAuthorizedSender: commandAuthorized,
				data: consumed.callbackData,
				kind: "modal",
				fields,
				messageId: consumed.messageId
			}) === "handled") return;
		}
		try {
			await interaction.acknowledge();
		} catch (err) {
			logError(`discord component modal: failed to acknowledge: ${String(err)}`);
		}
		const eventText = formatModalSubmissionText(consumed, interaction);
		await dispatchDiscordComponentEvent({
			ctx: this.ctx,
			interaction,
			interactionCtx,
			channelCtx,
			guildInfo,
			eventText,
			replyToId: consumed.messageId,
			routeOverrides: {
				sessionKey: consumed.sessionKey,
				agentId: consumed.agentId,
				accountId: consumed.accountId
			}
		});
	}
};
//#endregion
//#region extensions/discord/src/monitor/agent-components.system-controls.ts
var AgentComponentButton = class extends Button {
	constructor(ctx) {
		super();
		this.label = AGENT_BUTTON_KEY;
		this.customId = `${AGENT_BUTTON_KEY}:seed=1`;
		this.style = ButtonStyle.Primary;
		this.ctx = ctx;
	}
	async run(interaction, data) {
		const parsed = parseAgentComponentData(data);
		if (!parsed) {
			logError("agent button: failed to parse component data");
			try {
				await interaction.reply({
					content: "This button is no longer valid.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		const { componentId } = parsed;
		const interactionCtx = await resolveInteractionContextWithDmAuth({
			ctx: this.ctx,
			interaction,
			label: "agent button",
			componentLabel: "button",
			defer: false
		});
		if (!interactionCtx) return;
		const { channelId, user, username, userId, replyOpts, rawGuildId, isDirectMessage, isGroupDm, memberRoleIds } = interactionCtx;
		const allowed = await ensureAgentComponentInteractionAllowed({
			ctx: this.ctx,
			interaction,
			channelId,
			rawGuildId,
			memberRoleIds,
			user,
			replyOpts,
			componentLabel: "button",
			unauthorizedReply: "You are not authorized to use this button."
		});
		if (!allowed) return;
		const { parentId } = allowed;
		const route = resolveAgentComponentRoute({
			ctx: this.ctx,
			rawGuildId,
			memberRoleIds,
			isDirectMessage,
			isGroupDm,
			userId,
			channelId,
			parentId
		});
		const eventText = `[Discord component: ${componentId} clicked by ${username} (${userId})]`;
		logDebug(`agent button: enqueuing event for channel ${channelId}: ${eventText}`);
		enqueueSystemEvent$1(eventText, {
			sessionKey: route.sessionKey,
			contextKey: `discord:agent-button:${channelId}:${componentId}:${userId}`
		});
		await ackComponentInteraction({
			interaction,
			replyOpts,
			label: "agent button"
		});
	}
};
var AgentSelectMenu = class extends StringSelectMenu {
	constructor(ctx) {
		super();
		this.customId = `${AGENT_SELECT_KEY}:seed=1`;
		this.options = [];
		this.ctx = ctx;
	}
	async run(interaction, data) {
		const parsed = parseAgentComponentData(data);
		if (!parsed) {
			logError("agent select: failed to parse component data");
			try {
				await interaction.reply({
					content: "This select menu is no longer valid.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		const { componentId } = parsed;
		const interactionCtx = await resolveInteractionContextWithDmAuth({
			ctx: this.ctx,
			interaction,
			label: "agent select",
			componentLabel: "select menu",
			defer: false
		});
		if (!interactionCtx) return;
		const { channelId, user, username, userId, replyOpts, rawGuildId, isDirectMessage, isGroupDm, memberRoleIds } = interactionCtx;
		const allowed = await ensureAgentComponentInteractionAllowed({
			ctx: this.ctx,
			interaction,
			channelId,
			rawGuildId,
			memberRoleIds,
			user,
			replyOpts,
			componentLabel: "select",
			unauthorizedReply: "You are not authorized to use this select menu."
		});
		if (!allowed) return;
		const { parentId } = allowed;
		const values = interaction.values ?? [];
		const valuesText = values.length > 0 ? ` (selected: ${values.join(", ")})` : "";
		const route = resolveAgentComponentRoute({
			ctx: this.ctx,
			rawGuildId,
			memberRoleIds,
			isDirectMessage,
			isGroupDm,
			userId,
			channelId,
			parentId
		});
		const eventText = `[Discord select menu: ${componentId} interacted by ${username} (${userId})${valuesText}]`;
		logDebug(`agent select: enqueuing event for channel ${channelId}: ${eventText}`);
		enqueueSystemEvent$1(eventText, {
			sessionKey: route.sessionKey,
			contextKey: `discord:agent-select:${channelId}:${componentId}:${userId}`
		});
		await ackComponentInteraction({
			interaction,
			replyOpts,
			label: "agent select"
		});
	}
};
function createAgentComponentButton(ctx) {
	return new AgentComponentButton(ctx);
}
function createAgentSelectMenu(ctx) {
	return new AgentSelectMenu(ctx);
}
//#endregion
//#region extensions/discord/src/monitor/agent-components.wildcard-controls.ts
const SELECT_CONTROLS = {
	string: {
		type: ComponentType.StringSelect,
		customId: "__openclaw_discord_component_string_select_wildcard__",
		componentLabel: "select menu",
		label: "discord component select"
	},
	user: {
		type: ComponentType.UserSelect,
		customId: "__openclaw_discord_component_user_select_wildcard__",
		componentLabel: "user select",
		label: "discord component user select"
	},
	role: {
		type: ComponentType.RoleSelect,
		customId: "__openclaw_discord_component_role_select_wildcard__",
		componentLabel: "role select",
		label: "discord component role select"
	},
	mentionable: {
		type: ComponentType.MentionableSelect,
		customId: "__openclaw_discord_component_mentionable_select_wildcard__",
		componentLabel: "mentionable select",
		label: "discord component mentionable select"
	},
	channel: {
		type: ComponentType.ChannelSelect,
		customId: "__openclaw_discord_component_channel_select_wildcard__",
		componentLabel: "channel select",
		label: "discord component channel select"
	}
};
var DiscordComponentSelectControl = class extends BaseMessageInteractiveComponent {
	constructor(spec, ctx, handlers) {
		super();
		this.spec = spec;
		this.ctx = ctx;
		this.handlers = handlers;
		this.customIdParser = parseDiscordComponentCustomIdForInteraction;
		this.type = spec.type;
		this.customId = spec.customId;
	}
	serialize() {
		return this.type === ComponentType.StringSelect ? {
			type: this.type,
			custom_id: this.customId,
			options: []
		} : {
			type: this.type,
			custom_id: this.customId
		};
	}
	async run(interaction, data) {
		await this.handlers.handleComponentEvent({
			ctx: this.ctx,
			interaction,
			data,
			componentLabel: this.spec.componentLabel,
			label: this.spec.label,
			values: interaction.values ?? []
		});
	}
};
var DiscordComponentButton = class extends Button {
	constructor(ctx, handlers) {
		super();
		this.ctx = ctx;
		this.handlers = handlers;
		this.label = "component";
		this.customId = "__openclaw_discord_component_button_wildcard__";
		this.style = ButtonStyle.Primary;
		this.customIdParser = parseDiscordComponentCustomIdForInteraction;
	}
	async run(interaction, data) {
		if (parseDiscordComponentData(data, resolveInteractionCustomId(interaction))?.modalId) {
			await this.handlers.handleModalTrigger({
				ctx: this.ctx,
				interaction,
				data,
				label: "discord component modal"
			});
			return;
		}
		await this.handlers.handleComponentEvent({
			ctx: this.ctx,
			interaction,
			data,
			componentLabel: "button",
			label: "discord component button"
		});
	}
};
function createSelectControl(spec, ctx, handlers) {
	return new DiscordComponentSelectControl(spec, ctx, handlers);
}
function bindSelectControl(spec) {
	return (ctx, handlers) => createSelectControl(spec, ctx, handlers);
}
function createDiscordComponentButtonControl(ctx, handlers) {
	return new DiscordComponentButton(ctx, handlers);
}
const createDiscordComponentStringSelectControl = bindSelectControl(SELECT_CONTROLS.string);
const createDiscordComponentUserSelectControl = bindSelectControl(SELECT_CONTROLS.user);
const createDiscordComponentRoleSelectControl = bindSelectControl(SELECT_CONTROLS.role);
const createDiscordComponentMentionableSelectControl = bindSelectControl(SELECT_CONTROLS.mentionable);
const createDiscordComponentChannelSelectControl = bindSelectControl(SELECT_CONTROLS.channel);
//#endregion
//#region extensions/discord/src/monitor/agent-components.ts
function bindDiscordComponentControl(createControl) {
	return (ctx) => createControl(ctx, discordComponentControlHandlers);
}
const createDiscordComponentButton = bindDiscordComponentControl(createDiscordComponentButtonControl);
const createDiscordComponentStringSelect = bindDiscordComponentControl(createDiscordComponentStringSelectControl);
const createDiscordComponentUserSelect = bindDiscordComponentControl(createDiscordComponentUserSelectControl);
const createDiscordComponentRoleSelect = bindDiscordComponentControl(createDiscordComponentRoleSelectControl);
const createDiscordComponentMentionableSelect = bindDiscordComponentControl(createDiscordComponentMentionableSelectControl);
const createDiscordComponentChannelSelect = bindDiscordComponentControl(createDiscordComponentChannelSelectControl);
const createAgentComponentControls = [createAgentComponentButton, createAgentSelectMenu];
const createDiscordComponentControls = [
	createDiscordComponentButton,
	createDiscordComponentStringSelect,
	createDiscordComponentUserSelect,
	createDiscordComponentRoleSelect,
	createDiscordComponentMentionableSelect,
	createDiscordComponentChannelSelect
];
function createDiscordComponentModal(ctx) {
	return new DiscordComponentModal(ctx);
}
//#endregion
//#region extensions/discord/src/monitor/exec-approvals.ts
function decodeCustomIdValue(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
function parseExecApprovalData(data) {
	if (!data || typeof data !== "object") return null;
	const coerce = (value) => typeof value === "string" || typeof value === "number" ? String(value) : "";
	const rawId = coerce(data.id);
	const rawAction = coerce(data.action);
	if (!rawId || !rawAction) return null;
	const action = rawAction;
	if (action !== "allow-once" && action !== "allow-always" && action !== "deny") return null;
	return {
		approvalId: decodeCustomIdValue(rawId),
		action
	};
}
function isStructuredApprovalNotFoundError(err) {
	if (!err || typeof err !== "object") return false;
	const record = err;
	if (record.gatewayCode === "APPROVAL_NOT_FOUND") return true;
	return record.gatewayCode === "INVALID_REQUEST" && record.details?.reason === "APPROVAL_NOT_FOUND";
}
var ExecApprovalButton = class extends Button {
	constructor(ctx) {
		super();
		this.ctx = ctx;
		this.label = "execapproval";
		this.customId = "execapproval:seed=1";
		this.style = ButtonStyle.Primary;
	}
	async run(interaction, data) {
		const parsed = parseExecApprovalData(data);
		if (!parsed) {
			try {
				await interaction.reply({
					content: "This approval is no longer valid.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		const approvers = this.ctx.getApprovers();
		const userId = interaction.userId;
		if (!approvers.some((id) => id === userId)) {
			try {
				await interaction.reply({
					content: "⛔ You are not authorized to approve exec requests.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		const decisionLabel = parsed.action === "allow-once" ? "Allowed (once)" : parsed.action === "allow-always" ? "Allowed (always)" : "Denied";
		try {
			await interaction.acknowledge();
		} catch {}
		const result = await this.ctx.resolveApproval(parsed.approvalId, parsed.action);
		if (!result.ok && result.reason !== "not-found") try {
			await interaction.followUp({
				content: `Failed to submit approval decision for **${decisionLabel}**. The request may have expired or already been resolved.`,
				ephemeral: true
			});
		} catch {}
	}
};
function createExecApprovalButton(ctx) {
	return new ExecApprovalButton(ctx);
}
function createDiscordExecApprovalButtonContext(params) {
	return {
		getApprovers: () => getDiscordExecApprovalApprovers({
			cfg: params.cfg,
			accountId: params.accountId,
			configOverride: params.config
		}),
		resolveApproval: async (approvalId, decision) => {
			try {
				await resolveApprovalOverGateway({
					cfg: params.cfg,
					approvalId,
					decision,
					gatewayUrl: params.gatewayUrl,
					clientDisplayName: `Discord approval (${params.accountId})`
				});
				return { ok: true };
			} catch (err) {
				return {
					ok: false,
					reason: isStructuredApprovalNotFoundError(err) ? "not-found" : "error"
				};
			}
		}
	};
}
//#endregion
//#region extensions/discord/src/monitor/provider.interactions.ts
function createDiscordProviderInteractionSurface(params) {
	const createNativeCommand = params.createNativeCommand ?? createDiscordNativeCommand;
	const commands = params.commandSpecs.map((spec) => createNativeCommand({
		command: spec,
		cfg: params.cfg,
		discordConfig: params.discordConfig,
		accountId: params.accountId,
		sessionPrefix: params.sessionPrefix,
		ephemeralDefault: params.ephemeralDefault,
		threadBindings: params.threadBindings
	}));
	if (params.nativeEnabled && params.voiceEnabled) commands.push(createDiscordVoiceCommand({
		cfg: params.cfg,
		discordConfig: params.discordConfig,
		accountId: params.accountId,
		groupPolicy: params.groupPolicy,
		useAccessGroups: params.useAccessGroups,
		getManager: () => params.voiceManagerRef.current,
		ephemeralDefault: params.ephemeralDefault
	}));
	const execApprovalsConfig = params.discordConfig.execApprovals ?? {};
	const execApprovalsEnabled = isDiscordExecApprovalClientEnabled({
		cfg: params.cfg,
		accountId: params.accountId,
		configOverride: execApprovalsConfig
	});
	if (execApprovalsEnabled) registerChannelRuntimeContext({
		channelRuntime: params.channelRuntime,
		channelId: "discord",
		accountId: params.accountId,
		capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
		context: {
			token: params.token,
			config: execApprovalsConfig
		},
		abortSignal: params.abortSignal
	});
	const components = [
		createDiscordCommandArgFallbackButton({
			cfg: params.cfg,
			discordConfig: params.discordConfig,
			accountId: params.accountId,
			sessionPrefix: params.sessionPrefix,
			threadBindings: params.threadBindings
		}),
		createDiscordModelPickerFallbackButton({
			cfg: params.cfg,
			discordConfig: params.discordConfig,
			accountId: params.accountId,
			sessionPrefix: params.sessionPrefix,
			threadBindings: params.threadBindings
		}),
		createDiscordModelPickerFallbackSelect({
			cfg: params.cfg,
			discordConfig: params.discordConfig,
			accountId: params.accountId,
			sessionPrefix: params.sessionPrefix,
			threadBindings: params.threadBindings
		})
	];
	const modals = [];
	if (execApprovalsEnabled) components.push(createExecApprovalButton(createDiscordExecApprovalButtonContext({
		cfg: params.cfg,
		accountId: params.accountId,
		config: execApprovalsConfig
	})));
	if ((params.discordConfig.agentComponents ?? {}).enabled ?? true) {
		const componentContext = {
			cfg: params.cfg,
			discordConfig: params.discordConfig,
			accountId: params.accountId,
			guildEntries: params.guildEntries,
			allowFrom: params.allowFrom,
			dmPolicy: params.dmPolicy,
			runtime: params.runtime,
			token: params.token
		};
		components.push(...createAgentComponentControls.map((create) => create(componentContext)));
		components.push(...createDiscordComponentControls.map((create) => create(componentContext)));
		modals.push(createDiscordComponentModal(componentContext));
	}
	return {
		commands,
		components,
		modals
	};
}
//#endregion
//#region extensions/discord/src/gateway-logging.ts
const INFO_DEBUG_MARKERS = [
	"Gateway websocket closed",
	"Gateway reconnect scheduled in",
	"Gateway forcing fresh IDENTIFY after"
];
const shouldPromoteGatewayDebug = (message) => INFO_DEBUG_MARKERS.some((marker) => message.includes(marker));
const formatGatewayMetrics = (metrics) => {
	if (metrics === null || metrics === void 0) return String(metrics);
	if (typeof metrics === "string") return metrics;
	if (typeof metrics === "number" || typeof metrics === "boolean" || typeof metrics === "bigint") return String(metrics);
	try {
		return JSON.stringify(metrics);
	} catch {
		return "[unserializable metrics]";
	}
};
function attachDiscordGatewayLogging(params) {
	const { emitter, runtime } = params;
	if (!emitter) return () => {};
	const onGatewayDebug = (msg) => {
		const message = String(msg);
		logVerbose(`discord gateway: ${message}`);
		if (shouldPromoteGatewayDebug(message)) runtime.log?.(`discord gateway: ${message}`);
	};
	const onGatewayWarning = (warning) => {
		logVerbose(`discord gateway warning: ${String(warning)}`);
	};
	const onGatewayMetrics = (metrics) => {
		logVerbose(`discord gateway metrics: ${formatGatewayMetrics(metrics)}`);
	};
	emitter.on("debug", onGatewayDebug);
	emitter.on("warning", onGatewayWarning);
	emitter.on("metrics", onGatewayMetrics);
	return () => {
		emitter.removeListener("debug", onGatewayDebug);
		emitter.removeListener("warning", onGatewayWarning);
		emitter.removeListener("metrics", onGatewayMetrics);
	};
}
//#endregion
//#region extensions/discord/src/monitor.gateway.ts
async function waitForDiscordGatewayStop(params) {
	const { gateway, abortSignal } = params;
	return await new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			abortSignal?.removeEventListener("abort", onAbort);
			params.gatewaySupervisor?.detachLifecycle();
		};
		const finishResolve = () => {
			if (settled) return;
			settled = true;
			try {
				gateway?.disconnect?.();
			} finally {
				cleanup();
				resolve();
			}
		};
		const finishReject = (err) => {
			if (settled) return;
			settled = true;
			try {
				gateway?.disconnect?.();
			} finally {
				cleanup();
				reject(err);
			}
		};
		const onAbort = () => {
			finishResolve();
		};
		const onGatewayEvent = (event) => {
			if ((params.onGatewayEvent?.(event) ?? "stop") === "stop") finishReject(new DiscordGatewayLifecycleError(event));
		};
		const onForceStop = (err) => {
			finishReject(err);
		};
		if (abortSignal?.aborted) {
			onAbort();
			return;
		}
		abortSignal?.addEventListener("abort", onAbort, { once: true });
		params.gatewaySupervisor?.attachLifecycle(onGatewayEvent);
		params.registerForceStop?.(onForceStop);
	});
}
//#endregion
//#region extensions/discord/src/monitor/provider.lifecycle.ts
const DEFAULT_DISCORD_GATEWAY_READY_TIMEOUT_MS = 15e3;
const DEFAULT_DISCORD_GATEWAY_RUNTIME_READY_TIMEOUT_MS = 3e4;
const MAX_DISCORD_GATEWAY_READY_TIMEOUT_MS = 12e4;
const DISCORD_GATEWAY_READY_TIMEOUT_ENV = "OPENCLAW_DISCORD_READY_TIMEOUT_MS";
const DISCORD_GATEWAY_RUNTIME_READY_TIMEOUT_ENV = "OPENCLAW_DISCORD_RUNTIME_READY_TIMEOUT_MS";
const DISCORD_GATEWAY_READY_POLL_MS = 250;
const DISCORD_GATEWAY_STARTUP_DISCONNECT_DRAIN_TIMEOUT_MS = 5e3;
const DISCORD_GATEWAY_STARTUP_TERMINATE_CLOSE_TIMEOUT_MS = 1e3;
const DISCORD_GATEWAY_TRANSPORT_ACTIVITY_STATUS_MIN_INTERVAL_MS = 3e4;
function normalizeGatewayReadyTimeoutMs(value) {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(numeric) || numeric <= 0) return;
	return Math.min(Math.floor(numeric), MAX_DISCORD_GATEWAY_READY_TIMEOUT_MS);
}
function resolveDiscordGatewayReadyTimeoutMs(params) {
	return normalizeGatewayReadyTimeoutMs(params?.configuredTimeoutMs) ?? normalizeGatewayReadyTimeoutMs(params?.env?.[DISCORD_GATEWAY_READY_TIMEOUT_ENV]) ?? DEFAULT_DISCORD_GATEWAY_READY_TIMEOUT_MS;
}
function resolveDiscordGatewayRuntimeReadyTimeoutMs(params) {
	return normalizeGatewayReadyTimeoutMs(params?.configuredTimeoutMs) ?? normalizeGatewayReadyTimeoutMs(params?.env?.[DISCORD_GATEWAY_RUNTIME_READY_TIMEOUT_ENV]) ?? DEFAULT_DISCORD_GATEWAY_RUNTIME_READY_TIMEOUT_MS;
}
async function restartGatewayAfterReadyTimeout(params) {
	if (!params.gateway || params.abortSignal?.aborted) return;
	const socket = params.gateway.ws;
	if (!socket) {
		params.gateway.disconnect();
		if (!params.abortSignal?.aborted) params.gateway.connect(false);
		return;
	}
	await new Promise((resolve, reject) => {
		let settled = false;
		let drainTimeout;
		let terminateCloseTimeout;
		const ignoreSocketError = () => {};
		const clearTimers = () => {
			if (drainTimeout) {
				clearTimeout(drainTimeout);
				drainTimeout = void 0;
			}
			if (terminateCloseTimeout) {
				clearTimeout(terminateCloseTimeout);
				terminateCloseTimeout = void 0;
			}
		};
		const cleanup = () => {
			clearTimers();
			socket.removeListener("close", onClose);
			socket.removeListener("error", ignoreSocketError);
		};
		const finishResolve = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};
		const finishReject = (error) => {
			if (params.abortSignal?.aborted) {
				finishResolve();
				return;
			}
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onClose = () => {
			finishResolve();
		};
		socket.on("error", ignoreSocketError);
		socket.on("close", onClose);
		params.gateway?.disconnect();
		drainTimeout = setTimeout(() => {
			if (settled) return;
			if (typeof socket.terminate !== "function") {
				finishReject(/* @__PURE__ */ new Error(`discord gateway socket did not close within ${DISCORD_GATEWAY_STARTUP_DISCONNECT_DRAIN_TIMEOUT_MS}ms before restart`));
				return;
			}
			params.runtime.error?.(danger(`discord: startup restart waiting on a stale gateway socket for ${DISCORD_GATEWAY_STARTUP_DISCONNECT_DRAIN_TIMEOUT_MS}ms; forcing terminate before reconnect`));
			try {
				socket.terminate();
			} catch {
				finishReject(/* @__PURE__ */ new Error(`discord gateway socket did not close within ${DISCORD_GATEWAY_STARTUP_DISCONNECT_DRAIN_TIMEOUT_MS}ms before restart`));
				return;
			}
			terminateCloseTimeout = setTimeout(() => {
				finishReject(/* @__PURE__ */ new Error(`discord gateway socket did not close within ${DISCORD_GATEWAY_STARTUP_DISCONNECT_DRAIN_TIMEOUT_MS}ms before restart`));
			}, DISCORD_GATEWAY_STARTUP_TERMINATE_CLOSE_TIMEOUT_MS);
			terminateCloseTimeout.unref?.();
		}, DISCORD_GATEWAY_STARTUP_DISCONNECT_DRAIN_TIMEOUT_MS);
		drainTimeout.unref?.();
	});
	if (!params.abortSignal?.aborted) params.gateway.connect(false);
}
function parseGatewayCloseCode(message) {
	const match = /Gateway websocket closed:\s*(\d{3,5})/.exec(message);
	if (!match?.[1]) return;
	const code = Number.parseInt(match[1], 10);
	return Number.isFinite(code) ? code : void 0;
}
function resolveTransportActivityAt(event) {
	const at = event?.at;
	return typeof at === "number" && Number.isFinite(at) && at >= 0 ? at : Date.now();
}
function createGatewayStatusObserver(params) {
	let forceStopHandler;
	let queuedForceStopError;
	let readyPollId;
	let readyTimeoutId;
	const shouldStop = () => params.abortSignal?.aborted || params.isLifecycleStopping();
	const clearReadyWatch = () => {
		if (readyPollId) {
			clearInterval(readyPollId);
			readyPollId = void 0;
		}
		if (readyTimeoutId) {
			clearTimeout(readyTimeoutId);
			readyTimeoutId = void 0;
		}
	};
	const triggerForceStop = (err) => {
		if (forceStopHandler) {
			forceStopHandler(err);
			return;
		}
		queuedForceStopError = err;
	};
	const pushConnectedStatus = (at) => {
		params.pushStatus({
			...createConnectedChannelStatusPatch(at),
			lastDisconnect: null,
			lastError: null
		});
	};
	const startReadyWatch = () => {
		clearReadyWatch();
		const pollConnected = () => {
			if (shouldStop()) {
				clearReadyWatch();
				return;
			}
			if (!params.gateway?.isConnected) return;
			clearReadyWatch();
			pushConnectedStatus(Date.now());
		};
		pollConnected();
		if (!readyTimeoutId) {
			readyPollId = setInterval(pollConnected, DISCORD_GATEWAY_READY_POLL_MS);
			readyPollId.unref?.();
			readyTimeoutId = setTimeout(() => {
				clearReadyWatch();
				if (shouldStop() || params.gateway?.isConnected) return;
				const at = Date.now();
				const error = /* @__PURE__ */ new Error(`discord gateway opened but did not reach READY within ${params.runtimeReadyTimeoutMs}ms`);
				params.pushStatus({
					connected: false,
					lastEventAt: at,
					lastDisconnect: {
						at,
						error: "runtime-not-ready"
					},
					lastError: "runtime-not-ready"
				});
				params.runtime.error?.(danger(error.message));
				triggerForceStop(error);
			}, params.runtimeReadyTimeoutMs);
			readyTimeoutId.unref?.();
		}
	};
	const onGatewayDebug = (msg) => {
		if (shouldStop()) return;
		const at = Date.now();
		const message = String(msg);
		if (message.includes("Gateway websocket opened")) {
			params.pushStatus({
				connected: false,
				lastEventAt: at
			});
			startReadyWatch();
			return;
		}
		if (message.includes("Gateway websocket closed")) {
			clearReadyWatch();
			const code = parseGatewayCloseCode(message);
			params.pushStatus({
				connected: false,
				lastEventAt: at,
				lastDisconnect: {
					at,
					...code !== void 0 ? { status: code } : {}
				}
			});
			return;
		}
		if (message.includes("Gateway reconnect scheduled in")) {
			clearReadyWatch();
			params.pushStatus({
				connected: false,
				lastEventAt: at,
				lastError: message
			});
		}
	};
	return {
		onGatewayDebug,
		clearReadyWatch,
		registerForceStop: (handler) => {
			forceStopHandler = handler;
			if (queuedForceStopError !== void 0) {
				const err = queuedForceStopError;
				queuedForceStopError = void 0;
				handler(err);
			}
		},
		dispose: () => {
			clearReadyWatch();
			forceStopHandler = void 0;
			queuedForceStopError = void 0;
		}
	};
}
async function waitForGatewayReady(params) {
	const waitUntilReady = async () => {
		const deadlineAt = Date.now() + params.readyTimeoutMs;
		while (!params.abortSignal?.aborted) {
			if (await params.beforePoll?.() === "stop") return "stopped";
			if (params.gateway?.isConnected === true) {
				const at = Date.now();
				params.pushStatus?.({
					...createConnectedChannelStatusPatch(at),
					lastDisconnect: null,
					lastError: null
				});
				return "ready";
			}
			if (Date.now() >= deadlineAt) return "timeout";
			await new Promise((resolve) => {
				setTimeout(resolve, DISCORD_GATEWAY_READY_POLL_MS).unref?.();
			});
		}
		return "stopped";
	};
	if (await waitUntilReady() !== "timeout") return;
	if (!params.gateway) throw new Error(`discord gateway did not reach READY within ${params.readyTimeoutMs}ms`);
	const restartAt = Date.now();
	params.runtime.error?.(danger(`discord: gateway was not ready after ${params.readyTimeoutMs}ms; restarting gateway`));
	params.pushStatus?.({
		connected: false,
		lastEventAt: restartAt,
		lastDisconnect: {
			at: restartAt,
			error: "startup-not-ready"
		},
		lastError: "startup-not-ready"
	});
	if (params.abortSignal?.aborted) return;
	await params.beforeRestart?.();
	await restartGatewayAfterReadyTimeout({
		gateway: params.gateway,
		abortSignal: params.abortSignal,
		runtime: params.runtime
	});
	if (await waitUntilReady() === "timeout") throw new Error(`discord gateway did not reach READY within ${params.readyTimeoutMs}ms after restart`);
}
async function runDiscordGatewayLifecycle(params) {
	const gateway = params.gateway;
	if (gateway) registerGateway(params.accountId, gateway);
	const gatewayEmitter = params.gatewaySupervisor.emitter ?? getDiscordGatewayEmitter(gateway);
	const stopGatewayLogging = attachDiscordGatewayLogging({
		emitter: gatewayEmitter,
		runtime: params.runtime
	});
	let lifecycleStopping = false;
	const pushStatus = (patch) => {
		params.statusSink?.(patch);
	};
	const gatewayReadyTimeoutMs = resolveDiscordGatewayReadyTimeoutMs({
		configuredTimeoutMs: params.gatewayReadyTimeoutMs,
		env: process.env
	});
	const gatewayRuntimeReadyTimeoutMs = resolveDiscordGatewayRuntimeReadyTimeoutMs({
		configuredTimeoutMs: params.gatewayRuntimeReadyTimeoutMs,
		env: process.env
	});
	const statusObserver = createGatewayStatusObserver({
		gateway,
		abortSignal: params.abortSignal,
		runtime: params.runtime,
		pushStatus,
		isLifecycleStopping: () => lifecycleStopping,
		runtimeReadyTimeoutMs: gatewayRuntimeReadyTimeoutMs
	});
	gatewayEmitter?.on("debug", statusObserver.onGatewayDebug);
	let lastTransportActivityStatusAt;
	const onGatewayTransportActivity = (event) => {
		if (lifecycleStopping || params.abortSignal?.aborted) return;
		const at = resolveTransportActivityAt(event);
		if (lastTransportActivityStatusAt !== void 0 && at - lastTransportActivityStatusAt < DISCORD_GATEWAY_TRANSPORT_ACTIVITY_STATUS_MIN_INTERVAL_MS) return;
		lastTransportActivityStatusAt = at;
		pushStatus(createTransportActivityStatusPatch(at));
	};
	gatewayEmitter?.on(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, onGatewayTransportActivity);
	let sawDisallowedIntents = false;
	const handleGatewayEvent = (event) => {
		if (params.abortSignal?.aborted && event.type === "reconnect-exhausted") {
			lifecycleStopping = true;
			params.runtime.log?.(`discord: treating reconnect-exhausted during expected shutdown as clean: ${event.message}`);
			return "continue";
		}
		if (event.type === "disallowed-intents") {
			lifecycleStopping = true;
			sawDisallowedIntents = true;
			params.runtime.error?.(danger("discord: gateway closed with code 4014 (missing privileged gateway intents). Enable the required intents in the Discord Developer Portal or disable them in config."));
			return "stop";
		}
		if (event.shouldStopLifecycle) lifecycleStopping = true;
		params.runtime.error?.(danger(event.shouldStopLifecycle ? `discord gateway ${event.type}: ${event.message}` : `discord gateway error: ${event.message}`));
		return event.shouldStopLifecycle ? "stop" : "continue";
	};
	const drainPendingGatewayErrors = () => params.gatewaySupervisor.drainPending((event) => {
		if (handleGatewayEvent(event) !== "stop") return "continue";
		if (event.type === "disallowed-intents") return "stop";
		throw new DiscordGatewayLifecycleError(event);
	});
	try {
		if (drainPendingGatewayErrors() === "stop") return;
		await waitForGatewayReady({
			gateway,
			abortSignal: params.abortSignal,
			beforePoll: drainPendingGatewayErrors,
			pushStatus,
			runtime: params.runtime,
			beforeRestart: statusObserver.clearReadyWatch,
			readyTimeoutMs: gatewayReadyTimeoutMs
		});
		if (drainPendingGatewayErrors() === "stop") return;
		await waitForDiscordGatewayStop({
			gateway: gateway ? { disconnect: () => gateway.disconnect() } : void 0,
			abortSignal: params.abortSignal,
			gatewaySupervisor: params.gatewaySupervisor,
			onGatewayEvent: handleGatewayEvent,
			registerForceStop: statusObserver.registerForceStop
		});
	} catch (err) {
		if (!sawDisallowedIntents && !params.isDisallowedIntentsError(err)) throw err;
	} finally {
		lifecycleStopping = true;
		params.gatewaySupervisor.detachLifecycle();
		unregisterGateway(params.accountId);
		stopGatewayLogging();
		statusObserver.dispose();
		gatewayEmitter?.removeListener("debug", statusObserver.onGatewayDebug);
		gatewayEmitter?.removeListener(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, onGatewayTransportActivity);
		if (params.voiceManager) {
			await params.voiceManager.destroy();
			params.voiceManagerRef.current = null;
		}
		params.threadBindings.stop();
	}
}
//#endregion
//#region extensions/discord/src/internal/voice.ts
var VoicePlugin = class extends Plugin {
	constructor(..._args) {
		super(..._args);
		this.id = "voice";
		this.adapters = /* @__PURE__ */ new Map();
	}
	registerClient(client) {
		this.client = client;
		this.gatewayPlugin = client.getPlugin("gateway");
		if (!this.gatewayPlugin) throw new Error("Discord voice cannot be used without a gateway connection.");
	}
	getGateway(_guildId) {
		return this.gatewayPlugin;
	}
	getGatewayAdapterCreator(guildId) {
		const gateway = this.getGateway(guildId);
		if (!gateway) throw new Error("Discord voice cannot be used without a gateway connection.");
		return (methods) => {
			this.adapters.set(guildId, methods);
			return {
				sendPayload(payload) {
					try {
						gateway.send(payload, true);
						return true;
					} catch {
						return false;
					}
				},
				destroy: () => {
					this.adapters.delete(guildId);
				}
			};
		};
	}
};
//#endregion
//#region extensions/discord/src/monitor/provider.startup.ts
function registerLatePlugin(client, plugin) {
	plugin.registerClient?.(client);
	plugin.registerRoutes?.(client);
	if (!client.plugins.some((entry) => entry.id === plugin.id)) client.plugins.push({
		id: plugin.id,
		plugin
	});
}
function createDiscordStatusReadyListener(params) {
	return new class DiscordStatusReadyListener extends ReadyListener {
		async handle(_data, client) {
			const autoPresenceController = params.getAutoPresenceController();
			if (autoPresenceController?.enabled) {
				autoPresenceController.refresh();
				return;
			}
			const gateway = client.getPlugin("gateway");
			if (!gateway) return;
			const presence = resolveDiscordPresenceUpdate(params.discordConfig);
			if (!presence) return;
			gateway.updatePresence(presence);
		}
	}();
}
async function createDiscordMonitorClient(params) {
	let autoPresenceController = null;
	const clientPlugins = [params.createGatewayPlugin({
		discordConfig: params.discordConfig,
		runtime: params.runtime
	})];
	if (params.voiceEnabled) clientPlugins.push(new VoicePlugin());
	const voicePlugin = clientPlugins.find((plugin) => plugin.id === "voice");
	const constructorPlugins = voicePlugin ? clientPlugins.filter((plugin) => plugin !== voicePlugin) : clientPlugins;
	const eventQueueOpts = {
		listenerTimeout: 12e4,
		slowListenerThreshold: 3e4,
		...params.discordConfig.eventQueue
	};
	const readyListener = createDiscordStatusReadyListener({
		discordConfig: params.discordConfig,
		getAutoPresenceController: () => autoPresenceController
	});
	const client = params.createClient({
		baseUrl: "http://localhost",
		deploySecret: "a",
		clientId: params.applicationId,
		publicKey: "a",
		token: params.token,
		autoDeploy: false,
		commandDeployHashStorePath: path.join(resolveStateDir(process.env), "discord", "command-deploy-cache.json"),
		requestOptions: {
			timeout: DISCORD_REST_TIMEOUT_MS,
			runtimeProfile: "persistent",
			maxQueueSize: 1e3
		},
		eventQueue: eventQueueOpts
	}, {
		commands: params.commands,
		listeners: [readyListener],
		components: params.components,
		modals: params.modals
	}, constructorPlugins);
	if (voicePlugin) registerLatePlugin(client, voicePlugin);
	if (params.proxyFetch) client.rest = createDiscordRequestClient(params.token, {
		fetch: params.proxyFetch,
		timeout: DISCORD_REST_TIMEOUT_MS,
		runtimeProfile: "persistent",
		maxQueueSize: 1e3
	});
	const gateway = client.getPlugin("gateway");
	await waitForDiscordGatewayPluginRegistration(gateway);
	const gatewaySupervisor = params.createGatewaySupervisor({
		gateway,
		isDisallowedIntentsError: params.isDisallowedIntentsError,
		runtime: params.runtime
	});
	if (gateway) {
		autoPresenceController = params.createAutoPresenceController({
			accountId: params.accountId,
			discordConfig: params.discordConfig,
			gateway,
			log: (message) => params.runtime.log?.(message)
		});
		autoPresenceController.start();
	}
	return {
		client,
		gateway,
		gatewaySupervisor,
		autoPresenceController,
		eventQueueOpts
	};
}
async function fetchDiscordBotIdentity(params) {
	params.logStartupPhase("fetch-bot-identity:start");
	const parsedBotUserId = parseApplicationIdFromToken(params.token ?? "");
	if (parsedBotUserId) {
		params.logStartupPhase("fetch-bot-identity:done", `botUserId=${parsedBotUserId} botUserName=<missing> source=token`);
		return {
			botUserId: parsedBotUserId,
			botUserName: void 0
		};
	}
	let botUser;
	try {
		botUser = await params.client.fetchUser("@me");
	} catch (err) {
		params.runtime.error?.(danger(`discord: failed to fetch bot identity: ${String(err)}`));
		params.logStartupPhase("fetch-bot-identity:error", String(err));
		throw new Error("Failed to resolve Discord bot identity", { cause: err });
	}
	const botUserRecord = botUser;
	const botUserId = normalizeOptionalString(botUserRecord?.id);
	const botUserName = normalizeOptionalString(botUserRecord?.username) ?? normalizeOptionalString(botUserRecord?.globalName);
	if (!botUserId) {
		const details = "fetchUser(\"@me\") returned no usable id";
		params.runtime.error?.(danger(`discord: failed to fetch bot identity: ${details}`));
		params.logStartupPhase("fetch-bot-identity:error", details);
		throw new Error("Failed to resolve Discord bot identity");
	}
	params.logStartupPhase("fetch-bot-identity:done", `botUserId=${botUserId} botUserName=${botUserName ?? "<missing>"}`);
	return {
		botUserId,
		botUserName
	};
}
function registerDiscordMonitorListeners(params) {
	registerDiscordListener(params.client.listeners, new DiscordInteractionListener(params.logger, params.trackInboundEvent));
	registerDiscordListener(params.client.listeners, new DiscordMessageListener(params.messageHandler, params.logger, params.trackInboundEvent));
	if (shouldRegisterDiscordReactionListeners(params)) {
		const reactionListenerOptions = {
			cfg: params.cfg,
			accountId: params.accountId,
			runtime: params.runtime,
			botUserId: params.botUserId,
			dmEnabled: params.dmEnabled,
			groupDmEnabled: params.groupDmEnabled,
			groupDmChannels: params.groupDmChannels ?? [],
			dmPolicy: params.dmPolicy,
			allowFrom: params.allowFrom ?? [],
			groupPolicy: params.groupPolicy,
			allowNameMatching: isDangerousNameMatchingEnabled(params.discordConfig),
			guildEntries: params.guildEntries,
			logger: params.logger,
			onEvent: params.trackInboundEvent
		};
		registerDiscordListener(params.client.listeners, new DiscordReactionListener(reactionListenerOptions));
		registerDiscordListener(params.client.listeners, new DiscordReactionRemoveListener(reactionListenerOptions));
	}
	registerDiscordListener(params.client.listeners, new DiscordThreadUpdateListener(params.cfg, params.accountId, params.logger));
	if (params.discordConfig.intents?.presence) {
		registerDiscordListener(params.client.listeners, new DiscordPresenceListener({
			logger: params.logger,
			accountId: params.accountId
		}));
		params.runtime.log?.("discord: GuildPresences intent enabled — presence listener registered");
	}
}
function shouldRegisterDiscordReactionListeners(params) {
	if (params.dmEnabled || params.groupDmEnabled) return true;
	if (params.groupPolicy === "disabled") return false;
	const guildEntries = Object.values(params.guildEntries ?? {});
	if (guildEntries.length === 0) return true;
	return guildEntries.some((entry) => entry.reactionNotifications !== "off");
}
//#endregion
//#region extensions/discord/src/monitor/rest-fetch.ts
function resolveDiscordRestFetch(proxyUrl, runtime) {
	const fetcher = withValidatedDiscordProxy(resolveEffectiveDebugProxyUrl(proxyUrl), runtime, (proxy) => {
		const agent = new ProxyAgent(proxy);
		return wrapFetchWithAbortSignal(((input, init) => fetch$1(input, {
			...init,
			dispatcher: agent
		}).then((response) => {
			captureHttpExchange({
				url: resolveRequestUrl(input),
				method: init?.method ?? "GET",
				requestHeaders: init?.headers,
				requestBody: init?.body ?? null,
				response,
				flowId: randomUUID(),
				meta: { subsystem: "discord-rest" }
			});
			return response;
		})));
	});
	if (!fetcher) return fetch;
	runtime.log?.("discord: rest proxy enabled");
	return fetcher;
}
//#endregion
//#region extensions/discord/src/monitor/startup-status.ts
function formatDiscordStartupStatusMessage(params) {
	const identitySuffix = params.botIdentity ? ` as ${params.botIdentity}` : "";
	if (params.gatewayReady) return `logged in to discord${identitySuffix}`;
	return `discord client initialized${identitySuffix}; awaiting gateway readiness`;
}
//#endregion
//#region extensions/discord/src/monitor/provider.ts
const DEFAULT_DISCORD_MEDIA_MAX_MB = 100;
let discordVoiceRuntimePromise;
let discordProviderSessionRuntimePromise;
let fetchDiscordApplicationIdForTesting;
let createDiscordNativeCommandForTesting;
let runDiscordGatewayLifecycleForTesting;
let createDiscordGatewayPluginForTesting;
let createDiscordGatewaySupervisorForTesting;
let createClientForTesting;
let getPluginCommandSpecsForTesting;
let resolveDiscordAccountForTesting;
let resolveNativeCommandsEnabledForTesting;
let resolveNativeSkillsEnabledForTesting;
let listNativeCommandSpecsForConfigForTesting;
let listSkillCommandsForAgentsForTesting;
let isVerboseForTesting;
let shouldLogVerboseForTesting;
function logDiscordStartupPhase(params) {
	logDiscordStartupPhase$1({
		...params,
		isVerbose: isVerboseForTesting ?? isVerbose
	});
}
async function loadDiscordVoiceRuntime() {
	const promise = discordVoiceRuntimePromise ?? import("./manager.runtime-B0TEyget.js");
	discordVoiceRuntimePromise = promise;
	try {
		return await promise;
	} catch (error) {
		if (discordVoiceRuntimePromise === promise) discordVoiceRuntimePromise = void 0;
		throw error;
	}
}
async function loadDiscordProviderSessionRuntime() {
	const promise = discordProviderSessionRuntimePromise ?? import("./provider-session.runtime-DsHV-43E.js");
	discordProviderSessionRuntimePromise = promise;
	try {
		return await promise;
	} catch (error) {
		if (discordProviderSessionRuntimePromise === promise) discordProviderSessionRuntimePromise = void 0;
		throw error;
	}
}
const DISCORD_DISALLOWED_INTENTS_CODE = GatewayCloseCodes$1.DisallowedIntents;
function isDiscordDisallowedIntentsError(err) {
	if (!err) return false;
	return formatErrorMessage$1(err).includes(String(DISCORD_DISALLOWED_INTENTS_CODE));
}
async function monitorDiscordProvider(opts = {}) {
	const startupStartedAt = Date.now();
	const cfg = opts.config ?? getRuntimeConfig();
	const account = (resolveDiscordAccountForTesting ?? resolveDiscordAccount)({
		cfg,
		accountId: opts.accountId
	});
	const token = normalizeDiscordToken(opts.token ?? void 0, "channels.discord.token") ?? account.token;
	if (!token) throw new Error(`Discord bot token missing for account "${account.accountId}" (set discord.accounts.${account.accountId}.token or DISCORD_BOT_TOKEN for default).`);
	const runtime = opts.runtime ?? createNonExitingRuntime();
	const rawDiscordCfg = account.config;
	const discordRootThreadBindings = cfg.channels?.discord?.threadBindings;
	const discordAccountThreadBindings = cfg.channels?.discord?.accounts?.[account.accountId]?.threadBindings;
	const discordRestFetch = resolveDiscordRestFetch(rawDiscordCfg.proxy, runtime);
	const discordProxyFetch = resolveDiscordProxyFetchForAccount(account, cfg, runtime);
	const dmConfig = rawDiscordCfg.dm;
	const configuredDmAllowFrom = resolveDiscordAccountAllowFrom({
		cfg,
		accountId: account.accountId
	});
	let guildEntries = rawDiscordCfg.guilds;
	const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
	const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: cfg.channels?.discord !== void 0,
		groupPolicy: rawDiscordCfg.groupPolicy,
		defaultGroupPolicy
	});
	const discordCfg = rawDiscordCfg.groupPolicy === groupPolicy ? rawDiscordCfg : {
		...rawDiscordCfg,
		groupPolicy
	};
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "discord",
		accountId: account.accountId,
		blockedLabel: GROUP_POLICY_BLOCKED_LABEL.guild,
		log: (message) => runtime.log?.(warn(message))
	});
	let allowFrom = configuredDmAllowFrom ?? [];
	const mediaMaxBytes = (opts.mediaMaxMb ?? discordCfg.mediaMaxMb ?? DEFAULT_DISCORD_MEDIA_MAX_MB) * 1024 * 1024;
	const textLimit = resolveTextChunkLimit(cfg, "discord", account.accountId, { fallbackLimit: 2e3 });
	const historyLimit = Math.max(0, opts.historyLimit ?? discordCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 20);
	const replyToMode = opts.replyToMode ?? discordCfg.replyToMode ?? "off";
	const dmEnabled = dmConfig?.enabled ?? true;
	const dmPolicy = resolveDiscordAccountDmPolicy({
		cfg,
		accountId: account.accountId
	}) ?? "pairing";
	const discordProviderSessionRuntime = await loadDiscordProviderSessionRuntime();
	const threadBindingIdleTimeoutMs = discordProviderSessionRuntime.resolveThreadBindingIdleTimeoutMs({
		channelIdleHoursRaw: discordAccountThreadBindings?.idleHours ?? discordRootThreadBindings?.idleHours,
		sessionIdleHoursRaw: cfg.session?.threadBindings?.idleHours
	});
	const threadBindingMaxAgeMs = discordProviderSessionRuntime.resolveThreadBindingMaxAgeMs({
		channelMaxAgeHoursRaw: discordAccountThreadBindings?.maxAgeHours ?? discordRootThreadBindings?.maxAgeHours,
		sessionMaxAgeHoursRaw: cfg.session?.threadBindings?.maxAgeHours
	});
	const threadBindingsEnabled = discordProviderSessionRuntime.resolveThreadBindingsEnabled({
		channelEnabledRaw: discordAccountThreadBindings?.enabled ?? discordRootThreadBindings?.enabled,
		sessionEnabledRaw: cfg.session?.threadBindings?.enabled
	});
	const groupDmEnabled = dmConfig?.groupEnabled ?? false;
	const groupDmChannels = dmConfig?.groupChannels;
	const nativeEnabled = (resolveNativeCommandsEnabledForTesting ?? resolveNativeCommandsEnabled)({
		providerId: "discord",
		providerSetting: discordCfg.commands?.native,
		globalSetting: cfg.commands?.native
	});
	const nativeSkillsEnabled = (resolveNativeSkillsEnabledForTesting ?? resolveNativeSkillsEnabled)({
		providerId: "discord",
		providerSetting: discordCfg.commands?.nativeSkills,
		globalSetting: cfg.commands?.nativeSkills
	});
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const slashCommand = resolveDiscordSlashCommandConfig(discordCfg.slashCommand);
	const sessionPrefix = "discord:slash";
	const ephemeralDefault = slashCommand.ephemeral;
	const voiceEnabled = resolveDiscordVoiceEnabled(discordCfg.voice);
	const allowlistResolved = await resolveDiscordAllowlistConfig({
		token,
		guildEntries,
		allowFrom,
		fetcher: discordRestFetch,
		runtime
	});
	guildEntries = allowlistResolved.guildEntries;
	allowFrom = allowlistResolved.allowFrom ?? [];
	if ((shouldLogVerboseForTesting ?? shouldLogVerbose)()) logDiscordResolvedConfig({
		dmEnabled,
		dmPolicy,
		allowFrom,
		groupDmEnabled,
		groupDmChannels,
		groupPolicy,
		guildEntries,
		historyLimit,
		mediaMaxBytes,
		nativeEnabled,
		nativeSkillsEnabled,
		useAccessGroups,
		threadBindingsEnabled,
		threadBindingIdleTimeoutMs,
		threadBindingMaxAgeMs
	});
	logDiscordStartupPhase({
		runtime,
		accountId: account.accountId,
		phase: "fetch-application-id:start",
		startAt: startupStartedAt
	});
	const applicationId = (typeof discordCfg.applicationId === "string" && discordCfg.applicationId.trim() ? discordCfg.applicationId.trim() : void 0) ?? parseApplicationIdFromToken(token) ?? await (fetchDiscordApplicationIdForTesting ?? fetchDiscordApplicationId)(token, 4e3, discordRestFetch);
	if (!applicationId) throw new Error("Failed to resolve Discord application id");
	logDiscordStartupPhase({
		runtime,
		accountId: account.accountId,
		phase: "fetch-application-id:done",
		startAt: startupStartedAt,
		details: `applicationId=${applicationId}`
	});
	const { commandSpecs } = await resolveDiscordProviderCommandSpecs({
		cfg,
		runtime,
		nativeEnabled,
		nativeSkillsEnabled,
		listSkillCommandsForAgents: listSkillCommandsForAgentsForTesting ?? listSkillCommandsForAgents,
		listNativeCommandSpecsForConfig: listNativeCommandSpecsForConfigForTesting ?? listNativeCommandSpecsForConfig,
		getPluginCommandSpecs: getPluginCommandSpecsForTesting
	});
	const voiceManagerRef = { current: null };
	const threadBindings = threadBindingsEnabled ? discordProviderSessionRuntime.createThreadBindingManager({
		accountId: account.accountId,
		token,
		cfg,
		idleTimeoutMs: threadBindingIdleTimeoutMs,
		maxAgeMs: threadBindingMaxAgeMs
	}) : discordProviderSessionRuntime.createNoopThreadBindingManager(account.accountId);
	if (threadBindingsEnabled) {
		const uncertainProbeKeys = /* @__PURE__ */ new Set();
		const reconciliation = await discordProviderSessionRuntime.reconcileAcpThreadBindingsOnStartup({
			cfg,
			accountId: account.accountId,
			sendFarewell: false,
			healthProbe: async ({ sessionKey, session }) => {
				const probe = await probeDiscordAcpBindingHealth({
					cfg,
					sessionKey,
					storedState: session.acp?.state,
					lastActivityAt: session.acp?.lastActivityAt,
					providerSessionRuntime: discordProviderSessionRuntime
				});
				if (probe.status === "uncertain") uncertainProbeKeys.add(`${sessionKey}${probe.reason ? ` (${probe.reason})` : ""}`);
				return probe;
			}
		});
		if (reconciliation.removed > 0) logVerbose(`discord: removed ${reconciliation.removed}/${reconciliation.checked} stale ACP thread bindings on startup for account ${account.accountId}: ${reconciliation.staleSessionKeys.join(", ")}`);
		if (uncertainProbeKeys.size > 0) logVerbose(`discord: ACP thread-binding health probe uncertain for account ${account.accountId}: ${[...uncertainProbeKeys].join(", ")}`);
	}
	let lifecycleStarted = false;
	let gatewaySupervisor;
	let deactivateMessageHandler;
	let autoPresenceController = null;
	let lifecycleGateway;
	let earlyGatewayEmitter = gatewaySupervisor?.emitter;
	let onEarlyGatewayDebug;
	try {
		const { commands, components, modals } = createDiscordProviderInteractionSurface({
			cfg,
			discordConfig: discordCfg,
			accountId: account.accountId,
			token,
			commandSpecs,
			nativeEnabled,
			voiceEnabled,
			groupPolicy,
			useAccessGroups,
			sessionPrefix,
			ephemeralDefault,
			threadBindings,
			voiceManagerRef,
			guildEntries,
			allowFrom,
			dmPolicy,
			runtime,
			channelRuntime: opts.channelRuntime,
			abortSignal: opts.abortSignal,
			createNativeCommand: createDiscordNativeCommandForTesting ?? createDiscordNativeCommand
		});
		const { client, gateway, gatewaySupervisor: createdGatewaySupervisor, autoPresenceController: createdAutoPresenceController } = await createDiscordMonitorClient({
			accountId: account.accountId,
			applicationId,
			token,
			proxyFetch: discordProxyFetch,
			commands,
			components,
			modals,
			voiceEnabled,
			discordConfig: discordCfg,
			runtime,
			createClient: createClientForTesting ?? ((...args) => new Client(...args)),
			createGatewayPlugin: createDiscordGatewayPluginForTesting ?? createDiscordGatewayPlugin,
			createGatewaySupervisor: createDiscordGatewaySupervisorForTesting ?? createDiscordGatewaySupervisor,
			createAutoPresenceController: createDiscordAutoPresenceController,
			isDisallowedIntentsError: isDiscordDisallowedIntentsError
		});
		lifecycleGateway = gateway;
		gatewaySupervisor = createdGatewaySupervisor;
		autoPresenceController = createdAutoPresenceController;
		earlyGatewayEmitter = gatewaySupervisor.emitter;
		onEarlyGatewayDebug = (msg) => {
			if (!(isVerboseForTesting ?? isVerbose)()) return;
			runtime.log?.(`discord startup [${account.accountId}] gateway-debug ${Math.max(0, Date.now() - startupStartedAt)}ms ${String(msg)}`);
		};
		earlyGatewayEmitter?.on("debug", onEarlyGatewayDebug);
		logDiscordStartupPhase({
			runtime,
			accountId: account.accountId,
			phase: "deploy-commands:schedule",
			startAt: startupStartedAt,
			gateway: lifecycleGateway,
			details: `native=${nativeEnabled ? "on" : "off"} reconcile=on commandCount=${commands.length}`
		});
		runDiscordCommandDeployInBackground({
			client,
			runtime,
			enabled: nativeEnabled,
			accountId: account.accountId,
			startupStartedAt,
			shouldLogVerbose: shouldLogVerboseForTesting ?? shouldLogVerbose,
			isVerbose: isVerboseForTesting ?? isVerbose
		});
		const logger = createSubsystemLogger("discord/monitor");
		const guildHistories = /* @__PURE__ */ new Map();
		let { botUserId, botUserName } = await fetchDiscordBotIdentity({
			client,
			token,
			runtime,
			logStartupPhase: (phase, details) => logDiscordStartupPhase({
				runtime,
				accountId: account.accountId,
				phase,
				startAt: startupStartedAt,
				gateway: lifecycleGateway,
				details
			})
		});
		let voiceManager = null;
		if (voiceEnabled) {
			const { DiscordVoiceManager, DiscordVoiceReadyListener, DiscordVoiceResumedListener } = await loadDiscordVoiceRuntime();
			voiceManager = new DiscordVoiceManager({
				client,
				cfg,
				discordConfig: discordCfg,
				accountId: account.accountId,
				runtime,
				botUserId
			});
			voiceManagerRef.current = voiceManager;
			registerDiscordListener(client.listeners, new DiscordVoiceReadyListener(voiceManager));
			registerDiscordListener(client.listeners, new DiscordVoiceResumedListener(voiceManager));
		}
		const messageHandler = discordProviderSessionRuntime.createDiscordMessageHandler({
			cfg,
			discordConfig: discordCfg,
			accountId: account.accountId,
			token,
			runtime,
			setStatus: opts.setStatus,
			abortSignal: opts.abortSignal,
			botUserId,
			guildHistories,
			historyLimit,
			mediaMaxBytes,
			textLimit,
			replyToMode,
			dmEnabled,
			dmPolicy,
			groupDmEnabled,
			groupDmChannels,
			allowFrom,
			guildEntries,
			threadBindings,
			discordRestFetch
		});
		deactivateMessageHandler = messageHandler.deactivate;
		const trackInboundEvent = opts.setStatus ? () => {
			const at = Date.now();
			opts.setStatus?.({
				lastEventAt: at,
				lastInboundAt: at
			});
		} : void 0;
		registerDiscordMonitorListeners({
			cfg,
			client,
			accountId: account.accountId,
			discordConfig: discordCfg,
			runtime,
			botUserId,
			dmEnabled,
			groupDmEnabled,
			groupDmChannels,
			dmPolicy,
			allowFrom,
			groupPolicy,
			guildEntries,
			logger,
			messageHandler,
			trackInboundEvent
		});
		logDiscordStartupPhase({
			runtime,
			accountId: account.accountId,
			phase: "client-start",
			startAt: startupStartedAt,
			gateway: lifecycleGateway
		});
		const botIdentity = botUserId && botUserName ? `${botUserId} (${botUserName})` : botUserId ?? botUserName ?? "";
		runtime.log?.(formatDiscordStartupStatusMessage({
			gatewayReady: lifecycleGateway?.isConnected === true,
			botIdentity: botIdentity || void 0
		}));
		if (lifecycleGateway?.isConnected) opts.setStatus?.(createConnectedChannelStatusPatch());
		lifecycleStarted = true;
		earlyGatewayEmitter?.removeListener("debug", onEarlyGatewayDebug);
		onEarlyGatewayDebug = void 0;
		await (runDiscordGatewayLifecycleForTesting ?? runDiscordGatewayLifecycle)({
			accountId: account.accountId,
			gateway: lifecycleGateway,
			runtime,
			abortSignal: opts.abortSignal,
			statusSink: opts.setStatus,
			isDisallowedIntentsError: isDiscordDisallowedIntentsError,
			voiceManager,
			voiceManagerRef,
			threadBindings,
			gatewaySupervisor,
			gatewayReadyTimeoutMs: account.config.gatewayReadyTimeoutMs,
			gatewayRuntimeReadyTimeoutMs: account.config.gatewayRuntimeReadyTimeoutMs
		});
	} finally {
		cleanupDiscordProviderStartup({
			deactivateMessageHandler,
			autoPresenceController,
			setStatus: opts.setStatus,
			onEarlyGatewayDebug,
			earlyGatewayEmitter,
			lifecycleStarted,
			lifecycleGateway,
			gatewaySupervisor,
			threadBindings,
			runtime
		});
	}
}
//#endregion
export { createDiscordNativeCommand as a, waitForDiscordGatewayPluginRegistration as i, createDiscordGatewayPlugin as n, registerDiscordListener as o, resolveDiscordGatewayIntents as r, monitorDiscordProvider as t };
