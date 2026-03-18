import "./provider-env-vars-BfZUtZAn.js";
import { f as resolveThreadSessionKeys, s as init_session_key, u as normalizeMainKey, v as normalizeAccountId } from "./session-key-BSZsryCD.js";
import { $ as resolvePluginConversationBindingApproval, $t as warnMissingProviderGroupPolicyFallbackOnce, A as createDedupeCache, Ht as evaluateGroupRouteAccessForPolicy, K as buildPluginBindingResolvedText, Kt as init_group_access, M as init_map_size, N as pruneMapToMaxSize, O as dispatchPluginInteractiveHandler, Q as parsePluginBindingApprovalCustomId, Qt as resolveOpenProviderRuntimeGroupPolicy, Y as init_conversation_binding, Yt as init_runtime_group_policy, Zt as resolveDefaultGroupPolicy, an as resolveChannelEntryMatchWithFallback, en as applyChannelMatchMeta, i as resolveAgentRoute, j as init_dedupe, k as init_interactive, nn as init_channel_config, tn as buildChannelKeyCandidates } from "./resolve-route-CQsiaDZO.js";
import { a as init_types_secrets, c as normalizeResolvedSecretInputString } from "./types.secrets-Br5ssFsN.js";
import { t as getChildLogger } from "./logger-BOdgfoqz.js";
import "./tmp-openclaw-dir-DgEKZnX6.js";
import "./paths-CbmqEZIn.js";
import { C as warn, g as init_globals, l as init_runtime, m as danger, s as createNonExitingRuntime, v as logVerbose, x as shouldLogVerbose } from "./subsystem-CsPxmH8p.js";
import "./utils-CMc9mmF8.js";
import "./fetch-BgkAjqxB.js";
import "./retry-CgLvWye-.js";
import { V as normalizeStringEntries } from "./agent-scope-CM8plEdu.js";
import "./exec-CWMR162-.js";
import "./logger-C833gw0R.js";
import "./paths-DAoqckDF.js";
import { $n as sleepWithAbort, $o as createReplyPrefixOptions, $u as deleteSlackMessage, At as withTimeout, Go as installRequestBodyLimitGuard, Ho as resolveAgentOutboundIdentity, Id as normalizeSlackWebhookPath, It as resolvePinnedMainDmOwnerFromAllowlist, Jt as resolveControlCommandGate, Kt as recordInboundSession, Ld as registerSlackHttpHandler, Mt as readStoreAllowFromForDmPolicy, Nd as resolveTextChunkLimit, Np as resolveSlackNativeStreaming, Ot as createChannelInboundDebouncer, Pp as resolveSlackStreamingMode, Qn as computeBackoff, Qs as updateLastRoute, Rd as parseSlackBlocksInput, Sd as resolveSlackWebClientOptions, Sr as enqueueSystemEvent, Ss as shouldHandleTextCommands, Su as resolveSlackChannelAllowlist, Tm as resolveSlackChannelId, Ts as resolveNativeSkillsEnabled, Xt as removeAckReactionAfterReply, Xu as hasSlackThreadParticipation, Yp as withNormalizedTimestamp, Ys as readSessionUpdatedAt, Zo as createTypingCallbacks, Zt as shouldAckReaction, Zu as recordSlackThreadParticipation, _p as writeConfigFile, ad as listSlackReactions, an as dispatchInboundMessage, as as buildPendingHistoryContextFromMap, bd as normalizeSlackOutboundText, bn as resolveChannelConfigWrites, cd as readSlackMessages, cs as recordPendingHistoryEntryIfEnabled, dd as sendSlackMessage, dp as resolveConversationLabel, ed as downloadSlackFile, es as resolveAckReaction, fd as unpinSlackMessage, gd as resolveSlackThreadStarter, hd as resolveSlackThreadHistory, ic as resolveSessionKey, id as listSlackPins, if as resolveSlackBotToken, in as resolveEnvelopeFormatOptions, is as logTypingFailure, jp as mapStreamingModeToSlackLegacyDraftStreamMode, kf as generateSecureToken, kt as shouldDebounceTextInbound, ld as removeOwnSlackReactions, ln as hasControlCommand, ls as buildMentionRegexes, md as resolveSlackMedia, nd as getSlackMemberInfo, nf as resolveSlackReplyToMode, nn as formatInboundEnvelope, ns as logAckFailure, od as pinSlackMessage, os as clearHistoryEntriesIfEnabled, pd as resolveSlackAttachmentContent, pp as loadConfig, qt as resolveCommandAuthorizedFromAuthorizers, rd as listSlackEmojis, rf as resolveSlackAppToken, rs as logInboundDrop, sd as reactSlackMessage, sn as createReplyDispatcherWithTyping, td as editSlackMessage, tf as resolveSlackAccount, ts as resolveHumanDelayConfig, ud as removeSlackReaction, up as finalizeInboundContext, us as matchesMentionWithExplicit, va as upsertChannelPairingRequest, vd as sendMessageSlack, wm as parseSlackTarget, wo as issuePairingChallenge, ws as resolveNativeCommandsEnabled, xd as createSlackWebClient, xu as resolveSlackUserAllowlist, yu as truncateSlackText, z as createConnectedChannelStatusPatch, zt as resolveMentionGatingWithBypass } from "./auth-profiles-B70DPAVa.js";
import "./profiles-BC4VpDll.js";
import "./fetch-BX2RRCzB.js";
import { C as readReactionParams, E as readStringParam, S as readNumberParam, _ as createActionGate, b as jsonResult, y as imageResultFromFile } from "./external-content-CxoN_TKD.js";
import "./kilocode-shared-Ci8SRxXc.js";
import "./models-config.providers.static-DRBnLpDj.js";
import "./models-config.providers.discovery-gVOHvGnm.js";
import "./pairing-token-Do-E3rL5.js";
import { R as resolveStorePath } from "./query-expansion-Do6vyPvH.js";
import "./redact-BZcL_gJG.js";
import "./mime-33LCeGh-.js";
import { a as patchAllowlistUsersInConfigEntries, i as mergeAllowlist, l as formatAllowlistMatchMeta, n as buildAllowlistResolutionSummary, o as summarizeMapping, t as addAllowlistUserEntriesFromConfigEntry } from "./resolve-utils-D6VN4BvH.js";
import "./typebox-B4kR5eyM.js";
import "./web-search-plugin-factory-CeUlA68v.js";
import { t as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-DBR9vEe-.js";
import { a as normalizeSlackSlug, i as normalizeSlackAllowOwnerEntry, n as normalizeAllowList, o as resolveSlackAllowListMatch, r as normalizeAllowListLower, s as resolveSlackUserAllowed, t as allowListMatches } from "./allow-list-CoN7a9v-.js";
import { n as createDraftStreamLoop, t as resolveNativeCommandSessionTargets } from "./native-command-session-targets-CGUuHJty.js";
import { a as resolveSlackThreadTs, i as readSlackReplyBlocks, n as deliverReplies, t as createSlackReplyDeliveryPlan } from "./replies-BW-ZZLUC.js";
import { n as buildUntrustedChannelMetadata, t as chunkItems } from "./chunk-items-BpK2DFAg.js";
import * as SlackBoltNamespace from "@slack/bolt";
import SlackBolt from "@slack/bolt";
//#region extensions/slack/src/directory-live.ts
function resolveReadToken(params) {
	const account = resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	return account.userToken ?? account.botToken?.trim();
}
function normalizeQuery(value) {
	return value?.trim().toLowerCase() ?? "";
}
function buildUserRank(user) {
	let rank = 0;
	if (!user.deleted) rank += 2;
	if (!user.is_bot && !user.is_app_user) rank += 1;
	return rank;
}
function buildChannelRank(channel) {
	return channel.is_archived ? 0 : 1;
}
async function listSlackDirectoryPeersLive(params) {
	const token = resolveReadToken(params);
	if (!token) return [];
	const client = createSlackWebClient(token);
	const query = normalizeQuery(params.query);
	const members = [];
	let cursor;
	do {
		const res = await client.users.list({
			limit: 200,
			cursor
		});
		if (Array.isArray(res.members)) members.push(...res.members);
		const next = res.response_metadata?.next_cursor?.trim();
		cursor = next ? next : void 0;
	} while (cursor);
	const rows = members.filter((member) => {
		const candidates = [
			member.profile?.display_name || member.profile?.real_name || member.real_name,
			member.name,
			member.profile?.email
		].map((item) => item?.trim().toLowerCase()).filter(Boolean);
		if (!query) return true;
		return candidates.some((candidate) => candidate?.includes(query));
	}).map((member) => {
		const id = member.id?.trim();
		if (!id) return null;
		const handle = member.name?.trim();
		const display = member.profile?.display_name?.trim() || member.profile?.real_name?.trim() || member.real_name?.trim() || handle;
		return {
			kind: "user",
			id: `user:${id}`,
			name: display || void 0,
			handle: handle ? `@${handle}` : void 0,
			rank: buildUserRank(member),
			raw: member
		};
	}).filter(Boolean);
	if (typeof params.limit === "number" && params.limit > 0) return rows.slice(0, params.limit);
	return rows;
}
async function listSlackDirectoryGroupsLive(params) {
	const token = resolveReadToken(params);
	if (!token) return [];
	const client = createSlackWebClient(token);
	const query = normalizeQuery(params.query);
	const channels = [];
	let cursor;
	do {
		const res = await client.conversations.list({
			types: "public_channel,private_channel",
			exclude_archived: false,
			limit: 1e3,
			cursor
		});
		if (Array.isArray(res.channels)) channels.push(...res.channels);
		const next = res.response_metadata?.next_cursor?.trim();
		cursor = next ? next : void 0;
	} while (cursor);
	const rows = channels.filter((channel) => {
		const name = channel.name?.trim().toLowerCase();
		if (!query) return true;
		return Boolean(name && name.includes(query));
	}).map((channel) => {
		const id = channel.id?.trim();
		const name = channel.name?.trim();
		if (!id || !name) return null;
		return {
			kind: "group",
			id: `channel:${id}`,
			name,
			handle: `#${name}`,
			rank: buildChannelRank(channel),
			raw: channel
		};
	}).filter(Boolean);
	if (typeof params.limit === "number" && params.limit > 0) return rows.slice(0, params.limit);
	return rows;
}
//#endregion
//#region extensions/slack/src/monitor/commands.ts
/**
* Strip Slack mentions (<@U123>, <@U123|name>) so command detection works on
* normalized text. Use in both prepare and debounce gate for consistency.
*/
function stripSlackMentionsForCommandDetection(text) {
	return (text ?? "").replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeSlackSlashCommandName(raw) {
	return raw.replace(/^\/+/, "");
}
function resolveSlackSlashCommandConfig(raw) {
	const name = normalizeSlackSlashCommandName(raw?.name?.trim() || "openclaw") || "openclaw";
	return {
		enabled: raw?.enabled === true,
		name,
		sessionPrefix: raw?.sessionPrefix?.trim() || "slack:slash",
		ephemeral: raw?.ephemeral !== false
	};
}
function buildSlackSlashCommandMatcher(name) {
	const escaped = normalizeSlackSlashCommandName(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^/?${escaped}$`);
}
//#endregion
//#region extensions/slack/src/monitor/policy.ts
init_group_access();
function isSlackChannelAllowedByPolicy(params) {
	return evaluateGroupRouteAccessForPolicy({
		groupPolicy: params.groupPolicy,
		routeAllowlistConfigured: params.channelAllowlistConfigured,
		routeMatched: params.channelAllowed
	}).allowed;
}
//#endregion
//#region extensions/slack/src/monitor/channel-config.ts
init_dedupe();
init_map_size();
init_runtime_group_policy();
init_runtime();
init_globals();
init_types_secrets();
init_session_key();
init_channel_config();
function firstDefined(...values) {
	for (const value of values) if (typeof value !== "undefined") return value;
}
function resolveSlackChannelLabel(params) {
	const channelName = params.channelName?.trim();
	if (channelName) return `#${normalizeSlackSlug(channelName) || channelName}`;
	const channelId = params.channelId?.trim();
	return channelId ? `#${channelId}` : "unknown channel";
}
function resolveSlackChannelConfig(params) {
	const { channelId, channelName, channels, channelKeys, defaultRequireMention, allowNameMatching } = params;
	const entries = channels ?? {};
	const keys = channelKeys ?? Object.keys(entries);
	const normalizedName = channelName ? normalizeSlackSlug(channelName) : "";
	const directName = channelName ? channelName.trim() : "";
	const channelIdLower = channelId.toLowerCase();
	const channelIdUpper = channelId.toUpperCase();
	const match = resolveChannelEntryMatchWithFallback({
		entries,
		keys: buildChannelKeyCandidates(channelId, channelIdLower !== channelId ? channelIdLower : void 0, channelIdUpper !== channelId ? channelIdUpper : void 0, allowNameMatching ? channelName ? `#${directName}` : void 0 : void 0, allowNameMatching ? directName : void 0, allowNameMatching ? normalizedName : void 0),
		wildcardKey: "*"
	});
	const { entry: matched, wildcardEntry: fallback } = match;
	const requireMentionDefault = defaultRequireMention ?? true;
	if (keys.length === 0) return {
		allowed: true,
		requireMention: requireMentionDefault
	};
	if (!matched && !fallback) return {
		allowed: false,
		requireMention: requireMentionDefault
	};
	const resolved = matched ?? fallback ?? {};
	return applyChannelMatchMeta({
		allowed: firstDefined(resolved.enabled, resolved.allow, fallback?.enabled, fallback?.allow, true) ?? true,
		requireMention: firstDefined(resolved.requireMention, fallback?.requireMention, requireMentionDefault) ?? requireMentionDefault,
		allowBots: firstDefined(resolved.allowBots, fallback?.allowBots),
		users: firstDefined(resolved.users, fallback?.users),
		skills: firstDefined(resolved.skills, fallback?.skills),
		systemPrompt: firstDefined(resolved.systemPrompt, fallback?.systemPrompt)
	}, match);
}
//#endregion
//#region extensions/slack/src/monitor/channel-type.ts
function inferSlackChannelType(channelId) {
	const trimmed = channelId?.trim();
	if (!trimmed) return;
	if (trimmed.startsWith("D")) return "im";
	if (trimmed.startsWith("C")) return "channel";
	if (trimmed.startsWith("G")) return "group";
}
function normalizeSlackChannelType(channelType, channelId) {
	const normalized = channelType?.trim().toLowerCase();
	const inferred = inferSlackChannelType(channelId);
	if (normalized === "im" || normalized === "mpim" || normalized === "channel" || normalized === "group") {
		if (inferred === "im" && normalized !== "im") return "im";
		return normalized;
	}
	return inferred ?? "channel";
}
//#endregion
//#region extensions/slack/src/monitor/context.ts
function createSlackMonitorContext(params) {
	const channelHistories = /* @__PURE__ */ new Map();
	const logger = getChildLogger({ module: "slack-auto-reply" });
	const channelCache = /* @__PURE__ */ new Map();
	const userCache = /* @__PURE__ */ new Map();
	const seenMessages = createDedupeCache({
		ttlMs: 6e4,
		maxSize: 500
	});
	const allowFrom = normalizeAllowList(params.allowFrom);
	const groupDmChannels = normalizeAllowList(params.groupDmChannels);
	const groupDmChannelsLower = normalizeAllowListLower(groupDmChannels);
	const defaultRequireMention = params.defaultRequireMention ?? true;
	const hasChannelAllowlistConfig = Object.keys(params.channelsConfig ?? {}).length > 0;
	const channelsConfigKeys = Object.keys(params.channelsConfig ?? {});
	const markMessageSeen = (channelId, ts) => {
		if (!channelId || !ts) return false;
		return seenMessages.check(`${channelId}:${ts}`);
	};
	const resolveSlackSystemEventSessionKey = (p) => {
		const channelId = p.channelId?.trim() ?? "";
		if (!channelId) return params.mainKey;
		const channelType = normalizeSlackChannelType(p.channelType, channelId);
		const isDirectMessage = channelType === "im";
		const isGroup = channelType === "mpim";
		const from = isDirectMessage ? `slack:${channelId}` : isGroup ? `slack:group:${channelId}` : `slack:channel:${channelId}`;
		const chatType = isDirectMessage ? "direct" : isGroup ? "group" : "channel";
		const senderId = p.senderId?.trim() ?? "";
		try {
			const peerKind = isDirectMessage ? "direct" : isGroup ? "group" : "channel";
			const peerId = isDirectMessage ? senderId : channelId;
			if (peerId) return resolveAgentRoute({
				cfg: params.cfg,
				channel: "slack",
				accountId: params.accountId,
				teamId: params.teamId,
				peer: {
					kind: peerKind,
					id: peerId
				}
			}).sessionKey;
		} catch {}
		return resolveSessionKey(params.sessionScope, {
			From: from,
			ChatType: chatType,
			Provider: "slack"
		}, params.mainKey);
	};
	const resolveChannelName = async (channelId) => {
		const cached = channelCache.get(channelId);
		if (cached) return cached;
		try {
			const info = await params.app.client.conversations.info({
				token: params.botToken,
				channel: channelId
			});
			const name = info.channel && "name" in info.channel ? info.channel.name : void 0;
			const channel = info.channel ?? void 0;
			const entry = {
				name,
				type: channel?.is_im ? "im" : channel?.is_mpim ? "mpim" : channel?.is_channel ? "channel" : channel?.is_group ? "group" : void 0,
				topic: channel && "topic" in channel ? channel.topic?.value ?? void 0 : void 0,
				purpose: channel && "purpose" in channel ? channel.purpose?.value ?? void 0 : void 0
			};
			channelCache.set(channelId, entry);
			return entry;
		} catch {
			return {};
		}
	};
	const resolveUserName = async (userId) => {
		const cached = userCache.get(userId);
		if (cached) return cached;
		try {
			const info = await params.app.client.users.info({
				token: params.botToken,
				user: userId
			});
			const profile = info.user?.profile;
			const entry = { name: profile?.display_name || profile?.real_name || info.user?.name || void 0 };
			userCache.set(userId, entry);
			return entry;
		} catch {
			return {};
		}
	};
	const setSlackThreadStatus = async (p) => {
		if (!p.threadTs) return;
		const payload = {
			token: params.botToken,
			channel_id: p.channelId,
			thread_ts: p.threadTs,
			status: p.status
		};
		const client = params.app.client;
		try {
			if (client.assistant?.threads?.setStatus) {
				await client.assistant.threads.setStatus(payload);
				return;
			}
			if (typeof client.apiCall === "function") await client.apiCall("assistant.threads.setStatus", payload);
		} catch (err) {
			logVerbose(`slack status update failed for channel ${p.channelId}: ${String(err)}`);
		}
	};
	const isChannelAllowed = (p) => {
		const channelType = normalizeSlackChannelType(p.channelType, p.channelId);
		const isDirectMessage = channelType === "im";
		const isGroupDm = channelType === "mpim";
		const isRoom = channelType === "channel" || channelType === "group";
		if (isDirectMessage && !params.dmEnabled) return false;
		if (isGroupDm && !params.groupDmEnabled) return false;
		if (isGroupDm && groupDmChannels.length > 0) {
			const candidates = [
				p.channelId,
				p.channelName ? `#${p.channelName}` : void 0,
				p.channelName,
				p.channelName ? normalizeSlackSlug(p.channelName) : void 0
			].filter((value) => Boolean(value)).map((value) => value.toLowerCase());
			if (!(groupDmChannelsLower.includes("*") || candidates.some((candidate) => groupDmChannelsLower.includes(candidate)))) return false;
		}
		if (isRoom && p.channelId) {
			const channelConfig = resolveSlackChannelConfig({
				channelId: p.channelId,
				channelName: p.channelName,
				channels: params.channelsConfig,
				channelKeys: channelsConfigKeys,
				defaultRequireMention,
				allowNameMatching: params.allowNameMatching
			});
			const channelMatchMeta = formatAllowlistMatchMeta(channelConfig);
			const channelAllowed = channelConfig?.allowed !== false;
			const channelAllowlistConfigured = hasChannelAllowlistConfig;
			if (!isSlackChannelAllowedByPolicy({
				groupPolicy: params.groupPolicy,
				channelAllowlistConfigured,
				channelAllowed
			})) {
				logVerbose(`slack: drop channel ${p.channelId} (groupPolicy=${params.groupPolicy}, ${channelMatchMeta})`);
				return false;
			}
			const hasExplicitConfig = Boolean(channelConfig?.matchSource);
			if (!channelAllowed && (params.groupPolicy !== "open" || hasExplicitConfig)) {
				logVerbose(`slack: drop channel ${p.channelId} (${channelMatchMeta})`);
				return false;
			}
			logVerbose(`slack: allow channel ${p.channelId} (${channelMatchMeta})`);
		}
		return true;
	};
	const shouldDropMismatchedSlackEvent = (body) => {
		if (!body || typeof body !== "object") return false;
		const raw = body;
		const incomingApiAppId = typeof raw.api_app_id === "string" ? raw.api_app_id : "";
		const incomingTeamId = typeof raw.team_id === "string" ? raw.team_id : typeof raw.team?.id === "string" ? raw.team.id : "";
		if (params.apiAppId && incomingApiAppId && incomingApiAppId !== params.apiAppId) {
			logVerbose(`slack: drop event with api_app_id=${incomingApiAppId} (expected ${params.apiAppId})`);
			return true;
		}
		if (params.teamId && incomingTeamId && incomingTeamId !== params.teamId) {
			logVerbose(`slack: drop event with team_id=${incomingTeamId} (expected ${params.teamId})`);
			return true;
		}
		return false;
	};
	return {
		cfg: params.cfg,
		accountId: params.accountId,
		botToken: params.botToken,
		app: params.app,
		runtime: params.runtime,
		botUserId: params.botUserId,
		teamId: params.teamId,
		apiAppId: params.apiAppId,
		historyLimit: params.historyLimit,
		channelHistories,
		sessionScope: params.sessionScope,
		mainKey: params.mainKey,
		dmEnabled: params.dmEnabled,
		dmPolicy: params.dmPolicy,
		allowFrom,
		allowNameMatching: params.allowNameMatching,
		groupDmEnabled: params.groupDmEnabled,
		groupDmChannels,
		defaultRequireMention,
		channelsConfig: params.channelsConfig,
		channelsConfigKeys,
		groupPolicy: params.groupPolicy,
		useAccessGroups: params.useAccessGroups,
		reactionMode: params.reactionMode,
		reactionAllowlist: params.reactionAllowlist,
		replyToMode: params.replyToMode,
		threadHistoryScope: params.threadHistoryScope,
		threadInheritParent: params.threadInheritParent,
		slashCommand: params.slashCommand,
		textLimit: params.textLimit,
		ackReactionScope: params.ackReactionScope,
		typingReaction: params.typingReaction,
		mediaMaxBytes: params.mediaMaxBytes,
		removeAckAfterReply: params.removeAckAfterReply,
		logger,
		markMessageSeen,
		shouldDropMismatchedSlackEvent,
		resolveSlackSystemEventSessionKey,
		isChannelAllowed,
		resolveChannelName,
		resolveUserName,
		setSlackThreadStatus
	};
}
//#endregion
//#region extensions/slack/src/channel-migration.ts
function resolveAccountChannels(cfg, accountId) {
	if (!accountId) return {};
	const normalized = normalizeAccountId(accountId);
	const accounts = cfg.channels?.slack?.accounts;
	if (!accounts || typeof accounts !== "object") return {};
	const exact = accounts[normalized];
	if (exact?.channels) return { channels: exact.channels };
	const matchKey = Object.keys(accounts).find((key) => key.toLowerCase() === normalized.toLowerCase());
	return { channels: matchKey ? accounts[matchKey]?.channels : void 0 };
}
function migrateSlackChannelsInPlace(channels, oldChannelId, newChannelId) {
	if (!channels) return {
		migrated: false,
		skippedExisting: false
	};
	if (oldChannelId === newChannelId) return {
		migrated: false,
		skippedExisting: false
	};
	if (!Object.hasOwn(channels, oldChannelId)) return {
		migrated: false,
		skippedExisting: false
	};
	if (Object.hasOwn(channels, newChannelId)) return {
		migrated: false,
		skippedExisting: true
	};
	channels[newChannelId] = channels[oldChannelId];
	delete channels[oldChannelId];
	return {
		migrated: true,
		skippedExisting: false
	};
}
function migrateSlackChannelConfig(params) {
	const scopes = [];
	let migrated = false;
	let skippedExisting = false;
	const accountChannels = resolveAccountChannels(params.cfg, params.accountId).channels;
	if (accountChannels) {
		const result = migrateSlackChannelsInPlace(accountChannels, params.oldChannelId, params.newChannelId);
		if (result.migrated) {
			migrated = true;
			scopes.push("account");
		}
		if (result.skippedExisting) skippedExisting = true;
	}
	const globalChannels = params.cfg.channels?.slack?.channels;
	if (globalChannels) {
		const result = migrateSlackChannelsInPlace(globalChannels, params.oldChannelId, params.newChannelId);
		if (result.migrated) {
			migrated = true;
			scopes.push("global");
		}
		if (result.skippedExisting) skippedExisting = true;
	}
	return {
		migrated,
		skippedExisting,
		scopes
	};
}
//#endregion
//#region extensions/slack/src/monitor/events/channels.ts
init_globals();
function registerSlackChannelEvents(params) {
	const { ctx, trackEvent } = params;
	const enqueueChannelSystemEvent = (params) => {
		if (!ctx.isChannelAllowed({
			channelId: params.channelId,
			channelName: params.channelName,
			channelType: "channel"
		})) return;
		const label = resolveSlackChannelLabel({
			channelId: params.channelId,
			channelName: params.channelName
		});
		const sessionKey = ctx.resolveSlackSystemEventSessionKey({
			channelId: params.channelId,
			channelType: "channel"
		});
		enqueueSystemEvent(`Slack channel ${params.kind}: ${label}.`, {
			sessionKey,
			contextKey: `slack:channel:${params.kind}:${params.channelId ?? params.channelName ?? "unknown"}`
		});
	};
	ctx.app.event("channel_created", async ({ event, body }) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(body)) return;
			trackEvent?.();
			const payload = event;
			const channelId = payload.channel?.id;
			const channelName = payload.channel?.name;
			enqueueChannelSystemEvent({
				kind: "created",
				channelId,
				channelName
			});
		} catch (err) {
			ctx.runtime.error?.(danger(`slack channel created handler failed: ${String(err)}`));
		}
	});
	ctx.app.event("channel_rename", async ({ event, body }) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(body)) return;
			trackEvent?.();
			const payload = event;
			const channelId = payload.channel?.id;
			enqueueChannelSystemEvent({
				kind: "renamed",
				channelId,
				channelName: payload.channel?.name_normalized ?? payload.channel?.name
			});
		} catch (err) {
			ctx.runtime.error?.(danger(`slack channel rename handler failed: ${String(err)}`));
		}
	});
	ctx.app.event("channel_id_changed", async ({ event, body }) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(body)) return;
			trackEvent?.();
			const payload = event;
			const oldChannelId = payload.old_channel_id;
			const newChannelId = payload.new_channel_id;
			if (!oldChannelId || !newChannelId) return;
			const label = resolveSlackChannelLabel({
				channelId: newChannelId,
				channelName: (await ctx.resolveChannelName(newChannelId))?.name
			});
			ctx.runtime.log?.(warn(`[slack] Channel ID changed: ${oldChannelId} → ${newChannelId} (${label})`));
			if (!resolveChannelConfigWrites({
				cfg: ctx.cfg,
				channelId: "slack",
				accountId: ctx.accountId
			})) {
				ctx.runtime.log?.(warn("[slack] Config writes disabled; skipping channel config migration."));
				return;
			}
			const currentConfig = loadConfig();
			const migration = migrateSlackChannelConfig({
				cfg: currentConfig,
				accountId: ctx.accountId,
				oldChannelId,
				newChannelId
			});
			if (migration.migrated) {
				migrateSlackChannelConfig({
					cfg: ctx.cfg,
					accountId: ctx.accountId,
					oldChannelId,
					newChannelId
				});
				await writeConfigFile(currentConfig);
				ctx.runtime.log?.(warn("[slack] Channel config migrated and saved successfully."));
			} else if (migration.skippedExisting) ctx.runtime.log?.(warn(`[slack] Channel config already exists for ${newChannelId}; leaving ${oldChannelId} unchanged`));
			else ctx.runtime.log?.(warn(`[slack] No config found for old channel ID ${oldChannelId}; migration logged only`));
		} catch (err) {
			ctx.runtime.error?.(danger(`slack channel_id_changed handler failed: ${String(err)}`));
		}
	});
}
//#endregion
//#region extensions/slack/src/monitor/auth.ts
init_interactive();
init_conversation_binding();
let slackAllowFromCache = /* @__PURE__ */ new WeakMap();
const DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS = 5e3;
function getPairingAllowFromCacheTtlMs() {
	const raw = process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS?.trim();
	if (!raw) return DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS;
	return Math.max(0, Math.floor(parsed));
}
function getAllowFromCacheState(ctx) {
	const existing = slackAllowFromCache.get(ctx);
	if (existing) return existing;
	const next = {};
	slackAllowFromCache.set(ctx, next);
	return next;
}
function buildBaseAllowFrom(ctx) {
	const allowFrom = normalizeAllowList(ctx.allowFrom);
	return {
		allowFrom,
		allowFromLower: normalizeAllowListLower(allowFrom)
	};
}
async function resolveSlackEffectiveAllowFrom(ctx, options) {
	const includePairingStore = options?.includePairingStore === true;
	const cache = getAllowFromCacheState(ctx);
	const baseSignature = JSON.stringify(ctx.allowFrom);
	if (cache.baseSignature !== baseSignature || !cache.base) {
		cache.baseSignature = baseSignature;
		cache.base = buildBaseAllowFrom(ctx);
		cache.pairing = void 0;
		cache.pairingKey = void 0;
		cache.pairingExpiresAtMs = void 0;
		cache.pairingPending = void 0;
	}
	if (!includePairingStore) return cache.base;
	const ttlMs = getPairingAllowFromCacheTtlMs();
	const nowMs = Date.now();
	const pairingKey = `${ctx.accountId}:${ctx.dmPolicy}`;
	if (ttlMs > 0 && cache.pairing && cache.pairingKey === pairingKey && (cache.pairingExpiresAtMs ?? 0) >= nowMs) return cache.pairing;
	if (cache.pairingPending && cache.pairingKey === pairingKey) return await cache.pairingPending;
	const pairingPending = (async () => {
		let storeAllowFrom = [];
		try {
			const resolved = await readStoreAllowFromForDmPolicy({
				provider: "slack",
				accountId: ctx.accountId,
				dmPolicy: ctx.dmPolicy
			});
			storeAllowFrom = Array.isArray(resolved) ? resolved : [];
		} catch {
			storeAllowFrom = [];
		}
		const allowFrom = normalizeAllowList([...cache.base?.allowFrom ?? [], ...storeAllowFrom]);
		return {
			allowFrom,
			allowFromLower: normalizeAllowListLower(allowFrom)
		};
	})();
	cache.pairingKey = pairingKey;
	cache.pairingPending = pairingPending;
	try {
		const resolved = await pairingPending;
		if (ttlMs > 0) {
			cache.pairing = resolved;
			cache.pairingExpiresAtMs = nowMs + ttlMs;
		} else {
			cache.pairing = void 0;
			cache.pairingExpiresAtMs = void 0;
		}
		return resolved;
	} finally {
		if (cache.pairingPending === pairingPending) cache.pairingPending = void 0;
	}
}
function isSlackSenderAllowListed(params) {
	const { allowListLower, senderId, senderName, allowNameMatching } = params;
	return allowListLower.length === 0 || allowListMatches({
		allowList: allowListLower,
		id: senderId,
		name: senderName,
		allowNameMatching
	});
}
async function authorizeSlackSystemEventSender(params) {
	const senderId = params.senderId?.trim();
	if (!senderId) return {
		allowed: false,
		reason: "missing-sender"
	};
	const expectedSenderId = params.expectedSenderId?.trim();
	if (expectedSenderId && expectedSenderId !== senderId) return {
		allowed: false,
		reason: "sender-mismatch"
	};
	const channelId = params.channelId?.trim();
	let channelType = normalizeSlackChannelType(params.channelType, channelId);
	let channelName;
	if (channelId) {
		const info = await params.ctx.resolveChannelName(channelId).catch(() => ({}));
		channelName = info.name;
		channelType = normalizeSlackChannelType(params.channelType ?? info.type, channelId);
		if (!params.ctx.isChannelAllowed({
			channelId,
			channelName,
			channelType
		})) return {
			allowed: false,
			reason: "channel-not-allowed",
			channelType,
			channelName
		};
	}
	const senderName = (await params.ctx.resolveUserName(senderId).catch(() => ({}))).name;
	const resolveAllowFromLower = async (includePairingStore = false) => (await resolveSlackEffectiveAllowFrom(params.ctx, { includePairingStore })).allowFromLower;
	if (channelType === "im") {
		if (!params.ctx.dmEnabled || params.ctx.dmPolicy === "disabled") return {
			allowed: false,
			reason: "dm-disabled",
			channelType,
			channelName
		};
		if (params.ctx.dmPolicy !== "open") {
			if (!isSlackSenderAllowListed({
				allowListLower: await resolveAllowFromLower(true),
				senderId,
				senderName,
				allowNameMatching: params.ctx.allowNameMatching
			})) return {
				allowed: false,
				reason: "sender-not-allowlisted",
				channelType,
				channelName
			};
		}
	} else if (!channelId) {
		const allowFromLower = await resolveAllowFromLower(false);
		if (allowFromLower.length > 0) {
			if (!isSlackSenderAllowListed({
				allowListLower: allowFromLower,
				senderId,
				senderName,
				allowNameMatching: params.ctx.allowNameMatching
			})) return {
				allowed: false,
				reason: "sender-not-allowlisted"
			};
		}
	} else {
		const channelConfig = resolveSlackChannelConfig({
			channelId,
			channelName,
			channels: params.ctx.channelsConfig,
			channelKeys: params.ctx.channelsConfigKeys,
			defaultRequireMention: params.ctx.defaultRequireMention,
			allowNameMatching: params.ctx.allowNameMatching
		});
		if (Array.isArray(channelConfig?.users) && channelConfig.users.length > 0) {
			if (!resolveSlackUserAllowed({
				allowList: channelConfig?.users,
				userId: senderId,
				userName: senderName,
				allowNameMatching: params.ctx.allowNameMatching
			})) return {
				allowed: false,
				reason: "sender-not-channel-allowed",
				channelType,
				channelName
			};
		}
	}
	return {
		allowed: true,
		channelType,
		channelName
	};
}
//#endregion
//#region extensions/slack/src/monitor/mrkdwn.ts
function escapeSlackMrkdwn(value) {
	return value.replaceAll("\\", "\\\\").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/([*_`~])/g, "\\$1");
}
//#endregion
//#region extensions/slack/src/monitor/events/interactions.block-actions.ts
function readOptionValues(options) {
	if (!Array.isArray(options)) return;
	const values = options.map((option) => option && typeof option === "object" ? option.value : null).filter((value) => typeof value === "string" && value.trim().length > 0);
	return values.length > 0 ? values : void 0;
}
function readOptionLabels(options) {
	if (!Array.isArray(options)) return;
	const labels = options.map((option) => option && typeof option === "object" ? option.text?.text ?? null : null).filter((label) => typeof label === "string" && label.trim().length > 0);
	return labels.length > 0 ? labels : void 0;
}
function uniqueNonEmptyStrings(values) {
	const unique = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of values) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		unique.push(trimmed);
	}
	return unique;
}
function collectRichTextFragments(value, out) {
	if (!value || typeof value !== "object") return;
	const typed = value;
	if (typeof typed.text === "string" && typed.text.trim().length > 0) out.push(typed.text.trim());
	if (Array.isArray(typed.elements)) for (const child of typed.elements) collectRichTextFragments(child, out);
}
function summarizeRichTextPreview(value) {
	const fragments = [];
	collectRichTextFragments(value, fragments);
	if (fragments.length === 0) return;
	const joined = fragments.join(" ").replace(/\s+/g, " ").trim();
	if (!joined) return;
	const max = 120;
	return joined.length <= max ? joined : `${joined.slice(0, max - 1)}…`;
}
function readInteractionAction(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	return raw;
}
function summarizeAction(action) {
	const typed = action;
	const actionType = typed.type;
	const selectedUsers = uniqueNonEmptyStrings([...typed.selected_user ? [typed.selected_user] : [], ...Array.isArray(typed.selected_users) ? typed.selected_users : []]);
	const selectedChannels = uniqueNonEmptyStrings([...typed.selected_channel ? [typed.selected_channel] : [], ...Array.isArray(typed.selected_channels) ? typed.selected_channels : []]);
	const selectedConversations = uniqueNonEmptyStrings([...typed.selected_conversation ? [typed.selected_conversation] : [], ...Array.isArray(typed.selected_conversations) ? typed.selected_conversations : []]);
	const selectedValues = uniqueNonEmptyStrings([
		...typed.selected_option?.value ? [typed.selected_option.value] : [],
		...readOptionValues(typed.selected_options) ?? [],
		...selectedUsers,
		...selectedChannels,
		...selectedConversations
	]);
	const selectedLabels = uniqueNonEmptyStrings([...typed.selected_option?.text?.text ? [typed.selected_option.text.text] : [], ...readOptionLabels(typed.selected_options) ?? []]);
	const inputValue = typeof typed.value === "string" ? typed.value : void 0;
	const inputNumber = actionType === "number_input" && inputValue != null ? Number.parseFloat(inputValue) : void 0;
	const parsedNumber = Number.isFinite(inputNumber) ? inputNumber : void 0;
	const inputEmail = actionType === "email_text_input" && inputValue?.includes("@") ? inputValue : void 0;
	let inputUrl;
	if (actionType === "url_text_input" && inputValue) try {
		inputUrl = new URL(inputValue).toString();
	} catch {
		inputUrl = void 0;
	}
	const richTextValue = actionType === "rich_text_input" ? typed.rich_text_value : void 0;
	const richTextPreview = summarizeRichTextPreview(richTextValue);
	return {
		actionType,
		inputKind: actionType === "number_input" ? "number" : actionType === "email_text_input" ? "email" : actionType === "url_text_input" ? "url" : actionType === "rich_text_input" ? "rich_text" : inputValue != null ? "text" : void 0,
		value: typed.value,
		selectedValues: selectedValues.length > 0 ? selectedValues : void 0,
		selectedUsers: selectedUsers.length > 0 ? selectedUsers : void 0,
		selectedChannels: selectedChannels.length > 0 ? selectedChannels : void 0,
		selectedConversations: selectedConversations.length > 0 ? selectedConversations : void 0,
		selectedLabels: selectedLabels.length > 0 ? selectedLabels : void 0,
		selectedDate: typed.selected_date,
		selectedTime: typed.selected_time,
		selectedDateTime: typeof typed.selected_date_time === "number" ? typed.selected_date_time : void 0,
		inputValue,
		inputNumber: parsedNumber,
		inputEmail,
		inputUrl,
		richTextValue,
		richTextPreview,
		workflowTriggerUrl: typed.workflow?.trigger_url,
		workflowId: typed.workflow?.workflow_id
	};
}
function isBulkActionsBlock(block) {
	return block.type === "actions" && Array.isArray(block.elements) && block.elements.length > 0 && block.elements.every((el) => typeof el.action_id === "string" && el.action_id.includes("_all_"));
}
function formatInteractionSelectionLabel(params) {
	if (params.summary.actionType === "button" && params.buttonText?.trim()) return params.buttonText.trim();
	if (params.summary.selectedLabels?.length) {
		if (params.summary.selectedLabels.length <= 3) return params.summary.selectedLabels.join(", ");
		return `${params.summary.selectedLabels.slice(0, 3).join(", ")} +${params.summary.selectedLabels.length - 3}`;
	}
	if (params.summary.selectedValues?.length) {
		if (params.summary.selectedValues.length <= 3) return params.summary.selectedValues.join(", ");
		return `${params.summary.selectedValues.slice(0, 3).join(", ")} +${params.summary.selectedValues.length - 3}`;
	}
	if (params.summary.selectedDate) return params.summary.selectedDate;
	if (params.summary.selectedTime) return params.summary.selectedTime;
	if (typeof params.summary.selectedDateTime === "number") return (/* @__PURE__ */ new Date(params.summary.selectedDateTime * 1e3)).toISOString();
	if (params.summary.richTextPreview) return params.summary.richTextPreview;
	if (params.summary.value?.trim()) return params.summary.value.trim();
	return params.actionId;
}
function formatInteractionConfirmationText(params) {
	const actor = params.userId?.trim() ? ` by <@${params.userId.trim()}>` : "";
	return `:white_check_mark: *${escapeSlackMrkdwn(params.selectedLabel)}* selected${actor}`;
}
function buildSlackPluginInteractionData(params) {
	const actionId = params.actionId.trim();
	if (!actionId) return null;
	const payload = params.summary.value?.trim() || params.summary.selectedValues?.map((value) => value.trim()).find(Boolean) || "";
	if (actionId === "openclaw:reply_button" || actionId === "openclaw:reply_select") return payload || null;
	return payload ? `${actionId}:${payload}` : actionId;
}
function buildSlackPluginInteractionId(params) {
	const primaryValue = params.summary.value?.trim() || params.summary.selectedValues?.map((value) => value.trim()).find(Boolean) || "";
	return [
		params.userId?.trim() || "",
		params.channelId?.trim() || "",
		params.messageTs?.trim() || "",
		params.triggerId?.trim() || "",
		params.actionId.trim(),
		primaryValue
	].join(":");
}
function parseSlackBlockAction(params) {
	const typedBody = params.body;
	const typedAction = readInteractionAction(params.action);
	if (!typedAction) {
		params.log?.(`slack:interaction malformed action payload channel=${typedBody.channel?.id ?? typedBody.container?.channel_id ?? "unknown"} user=${typedBody.user?.id ?? "unknown"}`);
		return null;
	}
	const typedActionWithText = typedAction;
	return {
		typedBody,
		typedAction,
		typedActionWithText,
		actionId: typeof typedActionWithText.action_id === "string" ? typedActionWithText.action_id : "unknown",
		blockId: typedActionWithText.block_id,
		userId: typedBody.user?.id ?? "unknown",
		channelId: typedBody.channel?.id ?? typedBody.container?.channel_id,
		messageTs: typedBody.message?.ts ?? typedBody.container?.message_ts,
		threadTs: typedBody.container?.thread_ts,
		actionSummary: summarizeAction(typedAction)
	};
}
async function respondEphemeral(respond, text) {
	if (!respond) return;
	try {
		await respond({
			text,
			response_type: "ephemeral"
		});
	} catch {}
}
async function updateSlackInteractionMessage(params) {
	if (!params.channelId || !params.messageTs) return;
	await params.ctx.app.client.chat.update({
		channel: params.channelId,
		ts: params.messageTs,
		text: params.text,
		...params.blocks ? { blocks: params.blocks } : {}
	});
}
async function authorizeSlackBlockAction(params) {
	const auth = await authorizeSlackSystemEventSender({
		ctx: params.ctx,
		senderId: params.parsed.userId,
		channelId: params.parsed.channelId
	});
	if (auth.allowed) return auth;
	params.ctx.runtime.log?.(`slack:interaction drop action=${params.parsed.actionId} user=${params.parsed.userId} channel=${params.parsed.channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`);
	await respondEphemeral(params.respond, "You are not authorized to use this control.");
	return { allowed: false };
}
async function handleSlackPluginBindingApproval(params) {
	const pluginBindingApproval = parsePluginBindingApprovalCustomId(params.pluginInteractionData);
	if (!pluginBindingApproval) return false;
	const resolved = await resolvePluginConversationBindingApproval({
		approvalId: pluginBindingApproval.approvalId,
		decision: pluginBindingApproval.decision,
		senderId: params.parsed.userId
	});
	try {
		await updateSlackInteractionMessage({
			ctx: params.ctx,
			channelId: params.parsed.channelId,
			messageTs: params.parsed.messageTs,
			text: params.parsed.typedBody.message?.text ?? "",
			blocks: []
		});
	} catch {}
	await respondEphemeral(params.respond, buildPluginBindingResolvedText(resolved));
	return true;
}
async function dispatchSlackPluginInteraction(params) {
	const pluginInteractionId = buildSlackPluginInteractionId({
		userId: params.parsed.userId,
		channelId: params.parsed.channelId,
		messageTs: params.parsed.messageTs,
		triggerId: params.parsed.typedBody.trigger_id,
		actionId: params.parsed.actionId,
		summary: params.parsed.actionSummary
	});
	if (await handleSlackPluginBindingApproval({
		ctx: params.ctx,
		parsed: params.parsed,
		pluginInteractionData: params.pluginInteractionData,
		respond: params.respond
	})) return true;
	const pluginResult = await dispatchPluginInteractiveHandler({
		channel: "slack",
		data: params.pluginInteractionData,
		interactionId: pluginInteractionId,
		ctx: {
			accountId: params.ctx.accountId,
			interactionId: pluginInteractionId,
			conversationId: params.parsed.channelId ?? "",
			parentConversationId: void 0,
			threadId: params.parsed.threadTs,
			senderId: params.parsed.userId,
			senderUsername: void 0,
			auth: params.auth,
			interaction: {
				kind: params.parsed.actionSummary.actionType === "button" ? "button" : "select",
				actionId: params.parsed.actionId,
				blockId: params.parsed.blockId,
				messageTs: params.parsed.messageTs,
				threadTs: params.parsed.threadTs,
				value: params.parsed.actionSummary.value,
				selectedValues: params.parsed.actionSummary.selectedValues,
				selectedLabels: params.parsed.actionSummary.selectedLabels,
				triggerId: params.parsed.typedBody.trigger_id,
				responseUrl: params.parsed.typedBody.response_url
			}
		},
		respond: {
			acknowledge: async () => {},
			reply: async ({ text, responseType }) => {
				if (!text) return;
				await params.respond?.({
					text,
					response_type: responseType ?? "ephemeral"
				});
			},
			followUp: async ({ text, responseType }) => {
				if (!text) return;
				await params.respond?.({
					text,
					response_type: responseType ?? "ephemeral"
				});
			},
			editMessage: async ({ text, blocks }) => {
				await updateSlackInteractionMessage({
					ctx: params.ctx,
					channelId: params.parsed.channelId,
					messageTs: params.parsed.messageTs,
					text: text ?? params.parsed.typedBody.message?.text ?? "",
					blocks: Array.isArray(blocks) ? blocks : void 0
				});
			}
		}
	});
	return pluginResult.matched && pluginResult.handled;
}
function enqueueSlackBlockActionEvent(params) {
	const eventPayload = {
		interactionType: "block_action",
		actionId: params.parsed.actionId,
		blockId: params.parsed.blockId,
		...params.parsed.actionSummary,
		userId: params.parsed.userId,
		teamId: params.parsed.typedBody.team?.id,
		triggerId: params.parsed.typedBody.trigger_id,
		responseUrl: params.parsed.typedBody.response_url,
		channelId: params.parsed.channelId,
		messageTs: params.parsed.messageTs,
		threadTs: params.parsed.threadTs
	};
	params.ctx.runtime.log?.(`slack:interaction action=${params.parsed.actionId} type=${params.parsed.actionSummary.actionType ?? "unknown"} user=${params.parsed.userId} channel=${params.parsed.channelId}`);
	const sessionKey = params.ctx.resolveSlackSystemEventSessionKey({
		channelId: params.parsed.channelId,
		channelType: params.auth.channelType,
		senderId: params.parsed.userId
	});
	const contextParts = [
		"slack:interaction",
		params.parsed.channelId,
		params.parsed.messageTs,
		params.parsed.actionId
	].filter(Boolean);
	enqueueSystemEvent(params.formatSystemEvent(eventPayload), {
		sessionKey,
		contextKey: contextParts.join(":")
	});
}
function buildSlackConfirmationBlocks(params) {
	const selectedLabel = formatInteractionSelectionLabel({
		actionId: params.parsed.actionId,
		summary: params.parsed.actionSummary,
		buttonText: params.parsed.typedActionWithText.text?.text
	});
	let updatedBlocks = params.originalBlocks.map((block) => {
		const typedBlock = block;
		if (typedBlock.type === "actions" && typedBlock.block_id === params.parsed.blockId) return {
			type: "context",
			elements: [{
				type: "mrkdwn",
				text: formatInteractionConfirmationText({
					selectedLabel,
					userId: params.parsed.userId
				})
			}]
		};
		return block;
	});
	if (!updatedBlocks.some((block) => {
		const typedBlock = block;
		return typedBlock.type === "actions" && !isBulkActionsBlock(typedBlock);
	})) updatedBlocks = updatedBlocks.filter((block, index) => {
		const typedBlock = block;
		if (isBulkActionsBlock(typedBlock)) return false;
		if (typedBlock.type !== "divider") return true;
		const next = updatedBlocks[index + 1];
		return !next || !isBulkActionsBlock(next);
	});
	return updatedBlocks;
}
async function updateSlackLegacyBlockAction(params) {
	const originalBlocks = params.parsed.typedBody.message?.blocks;
	if (!Array.isArray(originalBlocks) || !params.parsed.channelId || !params.parsed.messageTs || !params.parsed.blockId) return;
	try {
		await updateSlackInteractionMessage({
			ctx: params.ctx,
			channelId: params.parsed.channelId,
			messageTs: params.parsed.messageTs,
			text: params.parsed.typedBody.message?.text ?? "",
			blocks: buildSlackConfirmationBlocks({
				parsed: params.parsed,
				originalBlocks
			})
		});
	} catch {
		await respondEphemeral(params.respond, `Button "${params.parsed.actionId}" clicked!`);
	}
}
async function handleSlackBlockAction(params) {
	const { ack, body, action, respond } = params.args;
	await ack();
	if (params.ctx.shouldDropMismatchedSlackEvent?.(body)) {
		params.ctx.runtime.log?.("slack:interaction drop block action payload (mismatched app/team)");
		return;
	}
	const parsed = parseSlackBlockAction({
		body,
		action,
		log: params.ctx.runtime.log
	});
	if (!parsed) return;
	const auth = await authorizeSlackBlockAction({
		ctx: params.ctx,
		parsed,
		respond
	});
	if (!auth.allowed) return;
	const pluginInteractionData = buildSlackPluginInteractionData({
		actionId: parsed.actionId,
		summary: parsed.actionSummary
	});
	if (pluginInteractionData) {
		if (await dispatchSlackPluginInteraction({
			ctx: params.ctx,
			parsed,
			pluginInteractionData,
			auth: { isAuthorizedSender: true },
			respond
		})) return;
	}
	enqueueSlackBlockActionEvent({
		ctx: params.ctx,
		parsed,
		auth,
		formatSystemEvent: params.formatSystemEvent
	});
	await updateSlackLegacyBlockAction({
		ctx: params.ctx,
		parsed,
		respond
	});
}
function registerSlackBlockActionHandler(params) {
	if (typeof params.ctx.app.action !== "function") return;
	params.ctx.app.action(/.+/, async (args) => {
		await handleSlackBlockAction({
			ctx: params.ctx,
			args,
			formatSystemEvent: params.formatSystemEvent
		});
	});
}
//#endregion
//#region extensions/slack/src/modal-metadata.ts
function normalizeString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function parseSlackModalPrivateMetadata(raw) {
	if (typeof raw !== "string" || raw.trim().length === 0) return {};
	try {
		const parsed = JSON.parse(raw);
		return {
			sessionKey: normalizeString(parsed.sessionKey),
			channelId: normalizeString(parsed.channelId),
			channelType: normalizeString(parsed.channelType),
			userId: normalizeString(parsed.userId)
		};
	} catch {
		return {};
	}
}
//#endregion
//#region extensions/slack/src/monitor/events/interactions.modal.ts
function resolveModalSessionRouting(params) {
	const metadata = params.metadata;
	if (metadata.sessionKey) return {
		sessionKey: metadata.sessionKey,
		channelId: metadata.channelId,
		channelType: metadata.channelType
	};
	if (metadata.channelId) return {
		sessionKey: params.ctx.resolveSlackSystemEventSessionKey({
			channelId: metadata.channelId,
			channelType: metadata.channelType,
			senderId: params.userId
		}),
		channelId: metadata.channelId,
		channelType: metadata.channelType
	};
	return { sessionKey: params.ctx.resolveSlackSystemEventSessionKey({}) };
}
function summarizeSlackViewLifecycleContext(view) {
	const rootViewId = view.root_view_id;
	const previousViewId = view.previous_view_id;
	return {
		rootViewId,
		previousViewId,
		externalId: view.external_id,
		viewHash: view.hash,
		isStackedView: Boolean(previousViewId)
	};
}
function resolveSlackModalEventBase(params) {
	const metadata = parseSlackModalPrivateMetadata(params.body.view?.private_metadata);
	const callbackId = params.body.view?.callback_id ?? "unknown";
	const userId = params.body.user?.id ?? "unknown";
	const viewId = params.body.view?.id;
	const inputs = params.summarizeViewState(params.body.view?.state?.values);
	const sessionRouting = resolveModalSessionRouting({
		ctx: params.ctx,
		metadata,
		userId
	});
	return {
		callbackId,
		userId,
		expectedUserId: metadata.userId,
		viewId,
		sessionRouting,
		payload: {
			actionId: `view:${callbackId}`,
			callbackId,
			viewId,
			userId,
			teamId: params.body.team?.id,
			...summarizeSlackViewLifecycleContext({
				root_view_id: params.body.view?.root_view_id,
				previous_view_id: params.body.view?.previous_view_id,
				external_id: params.body.view?.external_id,
				hash: params.body.view?.hash
			}),
			privateMetadata: params.body.view?.private_metadata,
			routedChannelId: sessionRouting.channelId,
			routedChannelType: sessionRouting.channelType,
			inputs
		}
	};
}
async function emitSlackModalLifecycleEvent(params) {
	const { callbackId, userId, expectedUserId, viewId, sessionRouting, payload } = resolveSlackModalEventBase({
		ctx: params.ctx,
		body: params.body,
		summarizeViewState: params.summarizeViewState
	});
	const isViewClosed = params.interactionType === "view_closed";
	const isCleared = params.body.is_cleared === true;
	const eventPayload = isViewClosed ? {
		interactionType: params.interactionType,
		...payload,
		isCleared
	} : {
		interactionType: params.interactionType,
		...payload
	};
	if (isViewClosed) params.ctx.runtime.log?.(`slack:interaction view_closed callback=${callbackId} user=${userId} cleared=${isCleared}`);
	else params.ctx.runtime.log?.(`slack:interaction view_submission callback=${callbackId} user=${userId} inputs=${payload.inputs.length}`);
	if (!expectedUserId) {
		params.ctx.runtime.log?.(`slack:interaction drop modal callback=${callbackId} user=${userId} reason=missing-expected-user`);
		return;
	}
	const auth = await authorizeSlackSystemEventSender({
		ctx: params.ctx,
		senderId: userId,
		channelId: sessionRouting.channelId,
		channelType: sessionRouting.channelType,
		expectedSenderId: expectedUserId
	});
	if (!auth.allowed) {
		params.ctx.runtime.log?.(`slack:interaction drop modal callback=${callbackId} user=${userId} reason=${auth.reason ?? "unauthorized"}`);
		return;
	}
	enqueueSystemEvent(params.formatSystemEvent(eventPayload), {
		sessionKey: sessionRouting.sessionKey,
		contextKey: [
			params.contextPrefix,
			callbackId,
			viewId,
			userId
		].filter(Boolean).join(":")
	});
}
function registerModalLifecycleHandler(params) {
	params.register(params.matcher, async ({ ack, body }) => {
		await ack();
		if (params.ctx.shouldDropMismatchedSlackEvent?.(body)) {
			params.ctx.runtime.log?.(`slack:interaction drop ${params.interactionType} payload (mismatched app/team)`);
			return;
		}
		await emitSlackModalLifecycleEvent({
			ctx: params.ctx,
			body,
			interactionType: params.interactionType,
			contextPrefix: params.contextPrefix,
			summarizeViewState: params.summarizeViewState,
			formatSystemEvent: params.formatSystemEvent
		});
	});
}
//#endregion
//#region extensions/slack/src/monitor/events/interactions.ts
const OPENCLAW_ACTION_PREFIX = "openclaw:";
const SLACK_INTERACTION_EVENT_PREFIX = "Slack interaction: ";
const REDACTED_INTERACTION_VALUE = "[redacted]";
const SLACK_INTERACTION_EVENT_MAX_CHARS = 2400;
const SLACK_INTERACTION_STRING_MAX_CHARS = 160;
const SLACK_INTERACTION_ARRAY_MAX_ITEMS = 64;
const SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS = 3;
const SLACK_INTERACTION_REDACTED_KEYS = new Set([
	"triggerId",
	"responseUrl",
	"workflowTriggerUrl",
	"privateMetadata",
	"viewHash"
]);
function sanitizeSlackInteractionPayloadValue(value, key) {
	if (value === void 0) return;
	if (key && SLACK_INTERACTION_REDACTED_KEYS.has(key)) {
		if (typeof value !== "string" || value.trim().length === 0) return;
		return REDACTED_INTERACTION_VALUE;
	}
	if (typeof value === "string") return truncateSlackText(value, SLACK_INTERACTION_STRING_MAX_CHARS);
	if (Array.isArray(value)) {
		const sanitized = value.slice(0, SLACK_INTERACTION_ARRAY_MAX_ITEMS).map((entry) => sanitizeSlackInteractionPayloadValue(entry)).filter((entry) => entry !== void 0);
		if (value.length > SLACK_INTERACTION_ARRAY_MAX_ITEMS) sanitized.push(`…+${value.length - SLACK_INTERACTION_ARRAY_MAX_ITEMS} more`);
		return sanitized;
	}
	if (!value || typeof value !== "object") return value;
	const output = {};
	for (const [entryKey, entryValue] of Object.entries(value)) {
		const sanitized = sanitizeSlackInteractionPayloadValue(entryValue, entryKey);
		if (sanitized === void 0) continue;
		if (typeof sanitized === "string" && sanitized.length === 0) continue;
		if (Array.isArray(sanitized) && sanitized.length === 0) continue;
		output[entryKey] = sanitized;
	}
	return output;
}
function buildCompactSlackInteractionPayload(payload) {
	const rawInputs = Array.isArray(payload.inputs) ? payload.inputs : [];
	const compactInputs = rawInputs.slice(0, SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS).flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const typed = entry;
		return [{
			actionId: typed.actionId,
			blockId: typed.blockId,
			actionType: typed.actionType,
			inputKind: typed.inputKind,
			selectedValues: typed.selectedValues,
			selectedLabels: typed.selectedLabels,
			inputValue: typed.inputValue,
			inputNumber: typed.inputNumber,
			selectedDate: typed.selectedDate,
			selectedTime: typed.selectedTime,
			selectedDateTime: typed.selectedDateTime,
			richTextPreview: typed.richTextPreview
		}];
	});
	return {
		interactionType: payload.interactionType,
		actionId: payload.actionId,
		callbackId: payload.callbackId,
		actionType: payload.actionType,
		userId: payload.userId,
		teamId: payload.teamId,
		channelId: payload.channelId ?? payload.routedChannelId,
		messageTs: payload.messageTs,
		threadTs: payload.threadTs,
		viewId: payload.viewId,
		isCleared: payload.isCleared,
		selectedValues: payload.selectedValues,
		selectedLabels: payload.selectedLabels,
		selectedDate: payload.selectedDate,
		selectedTime: payload.selectedTime,
		selectedDateTime: payload.selectedDateTime,
		workflowId: payload.workflowId,
		routedChannelType: payload.routedChannelType,
		inputs: compactInputs.length > 0 ? compactInputs : void 0,
		inputsOmitted: rawInputs.length > SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS ? rawInputs.length - SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS : void 0,
		payloadTruncated: true
	};
}
function formatSlackInteractionSystemEvent(payload) {
	const toEventText = (value) => `${SLACK_INTERACTION_EVENT_PREFIX}${JSON.stringify(value)}`;
	const sanitizedPayload = sanitizeSlackInteractionPayloadValue(payload) ?? {};
	let eventText = toEventText(sanitizedPayload);
	if (eventText.length <= SLACK_INTERACTION_EVENT_MAX_CHARS) return eventText;
	eventText = toEventText(sanitizeSlackInteractionPayloadValue(buildCompactSlackInteractionPayload(sanitizedPayload)));
	if (eventText.length <= SLACK_INTERACTION_EVENT_MAX_CHARS) return eventText;
	return toEventText({
		interactionType: sanitizedPayload.interactionType,
		actionId: sanitizedPayload.actionId ?? "unknown",
		userId: sanitizedPayload.userId,
		channelId: sanitizedPayload.channelId ?? sanitizedPayload.routedChannelId,
		payloadTruncated: true
	});
}
function summarizeViewState(values) {
	if (!values || typeof values !== "object") return [];
	const entries = [];
	for (const [blockId, blockValue] of Object.entries(values)) {
		if (!blockValue || typeof blockValue !== "object") continue;
		for (const [actionId, rawAction] of Object.entries(blockValue)) {
			if (!rawAction || typeof rawAction !== "object") continue;
			const actionSummary = summarizeAction(rawAction);
			entries.push({
				blockId,
				actionId,
				...actionSummary
			});
		}
	}
	return entries;
}
function registerSlackInteractionEvents(params) {
	const { ctx } = params;
	registerSlackBlockActionHandler({
		ctx,
		formatSystemEvent: formatSlackInteractionSystemEvent
	});
	if (typeof ctx.app.view !== "function") return;
	const modalMatcher = new RegExp(`^${OPENCLAW_ACTION_PREFIX}`);
	registerModalLifecycleHandler({
		register: (matcher, handler) => ctx.app.view(matcher, handler),
		matcher: modalMatcher,
		ctx,
		interactionType: "view_submission",
		contextPrefix: "slack:interaction:view",
		summarizeViewState,
		formatSystemEvent: formatSlackInteractionSystemEvent
	});
	const viewClosed = ctx.app.viewClosed;
	if (typeof viewClosed !== "function") return;
	registerModalLifecycleHandler({
		register: viewClosed,
		matcher: modalMatcher,
		ctx,
		interactionType: "view_closed",
		contextPrefix: "slack:interaction:view-closed",
		summarizeViewState,
		formatSystemEvent: formatSlackInteractionSystemEvent
	});
}
//#endregion
//#region extensions/slack/src/monitor/events/system-event-context.ts
init_globals();
async function authorizeAndResolveSlackSystemEventContext(params) {
	const { ctx, senderId, channelId, channelType, eventKind } = params;
	const auth = await authorizeSlackSystemEventSender({
		ctx,
		senderId,
		channelId,
		channelType
	});
	if (!auth.allowed) {
		logVerbose(`slack: drop ${eventKind} sender ${senderId ?? "unknown"} channel=${channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`);
		return;
	}
	return {
		channelLabel: resolveSlackChannelLabel({
			channelId,
			channelName: auth.channelName
		}),
		sessionKey: ctx.resolveSlackSystemEventSessionKey({
			channelId,
			channelType: auth.channelType,
			senderId
		})
	};
}
//#endregion
//#region extensions/slack/src/monitor/events/members.ts
init_globals();
function registerSlackMemberEvents(params) {
	const { ctx, trackEvent } = params;
	const handleMemberChannelEvent = async (params) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(params.body)) return;
			trackEvent?.();
			const payload = params.event;
			const channelId = payload.channel;
			const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
			const channelType = payload.channel_type ?? channelInfo?.type;
			const ingressContext = await authorizeAndResolveSlackSystemEventContext({
				ctx,
				senderId: payload.user,
				channelId,
				channelType,
				eventKind: `member-${params.verb}`
			});
			if (!ingressContext) return;
			enqueueSystemEvent(`Slack: ${(payload.user ? await ctx.resolveUserName(payload.user) : {})?.name ?? payload.user ?? "someone"} ${params.verb} ${ingressContext.channelLabel}.`, {
				sessionKey: ingressContext.sessionKey,
				contextKey: `slack:member:${params.verb}:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`
			});
		} catch (err) {
			ctx.runtime.error?.(danger(`slack ${params.verb} handler failed: ${String(err)}`));
		}
	};
	ctx.app.event("member_joined_channel", async ({ event, body }) => {
		await handleMemberChannelEvent({
			verb: "joined",
			event,
			body
		});
	});
	ctx.app.event("member_left_channel", async ({ event, body }) => {
		await handleMemberChannelEvent({
			verb: "left",
			event,
			body
		});
	});
}
//#endregion
//#region extensions/slack/src/monitor/events/message-subtype-handlers.ts
const SUBTYPE_HANDLER_REGISTRY = {
	message_changed: {
		subtype: "message_changed",
		eventKind: "message_changed",
		describe: (channelLabel) => `Slack message edited in ${channelLabel}.`,
		contextKey: (event) => {
			const changed = event;
			return `slack:message:changed:${changed.channel ?? "unknown"}:${changed.message?.ts ?? changed.previous_message?.ts ?? changed.event_ts ?? "unknown"}`;
		},
		resolveSenderId: (event) => {
			const changed = event;
			return changed.message?.user ?? changed.previous_message?.user ?? changed.message?.bot_id ?? changed.previous_message?.bot_id;
		},
		resolveChannelId: (event) => event.channel,
		resolveChannelType: () => void 0
	},
	message_deleted: {
		subtype: "message_deleted",
		eventKind: "message_deleted",
		describe: (channelLabel) => `Slack message deleted in ${channelLabel}.`,
		contextKey: (event) => {
			const deleted = event;
			return `slack:message:deleted:${deleted.channel ?? "unknown"}:${deleted.deleted_ts ?? deleted.event_ts ?? "unknown"}`;
		},
		resolveSenderId: (event) => {
			const deleted = event;
			return deleted.previous_message?.user ?? deleted.previous_message?.bot_id;
		},
		resolveChannelId: (event) => event.channel,
		resolveChannelType: () => void 0
	},
	thread_broadcast: {
		subtype: "thread_broadcast",
		eventKind: "thread_broadcast",
		describe: (channelLabel) => `Slack thread reply broadcast in ${channelLabel}.`,
		contextKey: (event) => {
			const thread = event;
			return `slack:thread:broadcast:${thread.channel ?? "unknown"}:${thread.message?.ts ?? thread.event_ts ?? "unknown"}`;
		},
		resolveSenderId: (event) => {
			const thread = event;
			return thread.user ?? thread.message?.user ?? thread.message?.bot_id;
		},
		resolveChannelId: (event) => event.channel,
		resolveChannelType: () => void 0
	}
};
function resolveSlackMessageSubtypeHandler(event) {
	const subtype = event.subtype;
	if (subtype !== "message_changed" && subtype !== "message_deleted" && subtype !== "thread_broadcast") return;
	return SUBTYPE_HANDLER_REGISTRY[subtype];
}
//#endregion
//#region extensions/slack/src/monitor/events/messages.ts
init_globals();
function registerSlackMessageEvents(params) {
	const { ctx, handleSlackMessage } = params;
	const handleIncomingMessageEvent = async ({ event, body }) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(body)) return;
			const message = event;
			const subtypeHandler = resolveSlackMessageSubtypeHandler(message);
			if (subtypeHandler) {
				const channelId = subtypeHandler.resolveChannelId(message);
				const ingressContext = await authorizeAndResolveSlackSystemEventContext({
					ctx,
					senderId: subtypeHandler.resolveSenderId(message),
					channelId,
					channelType: subtypeHandler.resolveChannelType(message),
					eventKind: subtypeHandler.eventKind
				});
				if (!ingressContext) return;
				enqueueSystemEvent(subtypeHandler.describe(ingressContext.channelLabel), {
					sessionKey: ingressContext.sessionKey,
					contextKey: subtypeHandler.contextKey(message)
				});
				return;
			}
			await handleSlackMessage(message, { source: "message" });
		} catch (err) {
			ctx.runtime.error?.(danger(`slack handler failed: ${String(err)}`));
		}
	};
	ctx.app.event("message", async ({ event, body }) => {
		await handleIncomingMessageEvent({
			event,
			body
		});
	});
	ctx.app.event("app_mention", async ({ event, body }) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(body)) return;
			const mention = event;
			const channelType = normalizeSlackChannelType(mention.channel_type, mention.channel);
			if (channelType === "im" || channelType === "mpim") return;
			await handleSlackMessage(mention, {
				source: "app_mention",
				wasMentioned: true
			});
		} catch (err) {
			ctx.runtime.error?.(danger(`slack mention handler failed: ${String(err)}`));
		}
	});
}
//#endregion
//#region extensions/slack/src/monitor/events/pins.ts
init_globals();
async function handleSlackPinEvent(params) {
	const { ctx, trackEvent, body, event, action, contextKeySuffix, errorLabel } = params;
	try {
		if (ctx.shouldDropMismatchedSlackEvent(body)) return;
		trackEvent?.();
		const payload = event;
		const channelId = payload.channel_id;
		const ingressContext = await authorizeAndResolveSlackSystemEventContext({
			ctx,
			senderId: payload.user,
			channelId,
			eventKind: "pin"
		});
		if (!ingressContext) return;
		const userLabel = (payload.user ? await ctx.resolveUserName(payload.user) : {})?.name ?? payload.user ?? "someone";
		const itemType = payload.item?.type ?? "item";
		const messageId = payload.item?.message?.ts ?? payload.event_ts;
		enqueueSystemEvent(`Slack: ${userLabel} ${action} a ${itemType} in ${ingressContext.channelLabel}.`, {
			sessionKey: ingressContext.sessionKey,
			contextKey: `slack:pin:${contextKeySuffix}:${channelId ?? "unknown"}:${messageId ?? "unknown"}`
		});
	} catch (err) {
		ctx.runtime.error?.(danger(`slack ${errorLabel} handler failed: ${String(err)}`));
	}
}
function registerSlackPinEvents(params) {
	const { ctx, trackEvent } = params;
	ctx.app.event("pin_added", async ({ event, body }) => {
		await handleSlackPinEvent({
			ctx,
			trackEvent,
			body,
			event,
			action: "pinned",
			contextKeySuffix: "added",
			errorLabel: "pin added"
		});
	});
	ctx.app.event("pin_removed", async ({ event, body }) => {
		await handleSlackPinEvent({
			ctx,
			trackEvent,
			body,
			event,
			action: "unpinned",
			contextKeySuffix: "removed",
			errorLabel: "pin removed"
		});
	});
}
//#endregion
//#region extensions/slack/src/monitor/events/reactions.ts
init_globals();
function registerSlackReactionEvents(params) {
	const { ctx, trackEvent } = params;
	const handleReactionEvent = async (event, action) => {
		try {
			const item = event.item;
			if (!item || item.type !== "message") return;
			trackEvent?.();
			const ingressContext = await authorizeAndResolveSlackSystemEventContext({
				ctx,
				senderId: event.user,
				channelId: item.channel,
				eventKind: "reaction"
			});
			if (!ingressContext) return;
			const actorInfoPromise = event.user ? ctx.resolveUserName(event.user) : Promise.resolve(void 0);
			const authorInfoPromise = event.item_user ? ctx.resolveUserName(event.item_user) : Promise.resolve(void 0);
			const [actorInfo, authorInfo] = await Promise.all([actorInfoPromise, authorInfoPromise]);
			const actorLabel = actorInfo?.name ?? event.user;
			const emojiLabel = event.reaction ?? "emoji";
			const authorLabel = authorInfo?.name ?? event.item_user;
			const baseText = `Slack reaction ${action}: :${emojiLabel}: by ${actorLabel} in ${ingressContext.channelLabel} msg ${item.ts}`;
			enqueueSystemEvent(authorLabel ? `${baseText} from ${authorLabel}` : baseText, {
				sessionKey: ingressContext.sessionKey,
				contextKey: `slack:reaction:${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}`
			});
		} catch (err) {
			ctx.runtime.error?.(danger(`slack reaction handler failed: ${String(err)}`));
		}
	};
	ctx.app.event("reaction_added", async ({ event, body }) => {
		if (ctx.shouldDropMismatchedSlackEvent(body)) return;
		await handleReactionEvent(event, "added");
	});
	ctx.app.event("reaction_removed", async ({ event, body }) => {
		if (ctx.shouldDropMismatchedSlackEvent(body)) return;
		await handleReactionEvent(event, "removed");
	});
}
//#endregion
//#region extensions/slack/src/monitor/events.ts
function registerSlackMonitorEvents(params) {
	registerSlackMessageEvents({
		ctx: params.ctx,
		handleSlackMessage: params.handleSlackMessage
	});
	registerSlackReactionEvents({
		ctx: params.ctx,
		trackEvent: params.trackEvent
	});
	registerSlackMemberEvents({
		ctx: params.ctx,
		trackEvent: params.trackEvent
	});
	registerSlackChannelEvents({
		ctx: params.ctx,
		trackEvent: params.trackEvent
	});
	registerSlackPinEvents({
		ctx: params.ctx,
		trackEvent: params.trackEvent
	});
	registerSlackInteractionEvents({ ctx: params.ctx });
}
//#endregion
//#region extensions/slack/src/draft-stream.ts
const SLACK_STREAM_MAX_CHARS = 4e3;
const DEFAULT_THROTTLE_MS = 1e3;
function createSlackDraftStream(params) {
	const maxChars = Math.min(params.maxChars ?? SLACK_STREAM_MAX_CHARS, SLACK_STREAM_MAX_CHARS);
	const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
	const send = params.send ?? sendMessageSlack;
	const edit = params.edit ?? editSlackMessage;
	const remove = params.remove ?? deleteSlackMessage;
	let streamMessageId;
	let streamChannelId;
	let lastSentText = "";
	let stopped = false;
	const sendOrEditStreamMessage = async (text) => {
		if (stopped) return;
		const trimmed = text.trimEnd();
		if (!trimmed) return;
		if (trimmed.length > maxChars) {
			stopped = true;
			params.warn?.(`slack stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
			return;
		}
		if (trimmed === lastSentText) return;
		lastSentText = trimmed;
		try {
			if (streamChannelId && streamMessageId) {
				await edit(streamChannelId, streamMessageId, trimmed, {
					token: params.token,
					accountId: params.accountId
				});
				return;
			}
			const sent = await send(params.target, trimmed, {
				token: params.token,
				accountId: params.accountId,
				threadTs: params.resolveThreadTs?.()
			});
			streamChannelId = sent.channelId || streamChannelId;
			streamMessageId = sent.messageId || streamMessageId;
			if (!streamChannelId || !streamMessageId) {
				stopped = true;
				params.warn?.("slack stream preview stopped (missing identifiers from sendMessage)");
				return;
			}
			params.onMessageSent?.();
		} catch (err) {
			stopped = true;
			params.warn?.(`slack stream preview failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	const loop = createDraftStreamLoop({
		throttleMs,
		isStopped: () => stopped,
		sendOrEditStreamMessage
	});
	const stop = () => {
		stopped = true;
		loop.stop();
	};
	const clear = async () => {
		stop();
		await loop.waitForInFlight();
		const channelId = streamChannelId;
		const messageId = streamMessageId;
		streamChannelId = void 0;
		streamMessageId = void 0;
		lastSentText = "";
		if (!channelId || !messageId) return;
		try {
			await remove(channelId, messageId, {
				token: params.token,
				accountId: params.accountId
			});
		} catch (err) {
			params.warn?.(`slack stream preview cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	const forceNewMessage = () => {
		streamMessageId = void 0;
		streamChannelId = void 0;
		lastSentText = "";
		loop.resetPending();
	};
	params.log?.(`slack stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);
	return {
		update: loop.update,
		flush: loop.flush,
		clear,
		stop,
		forceNewMessage,
		messageId: () => streamMessageId,
		channelId: () => streamChannelId
	};
}
//#endregion
//#region extensions/slack/src/stream-mode.ts
function resolveSlackStreamingConfig(params) {
	const mode = resolveSlackStreamingMode(params);
	return {
		mode,
		nativeStreaming: resolveSlackNativeStreaming(params),
		draftMode: mapStreamingModeToSlackLegacyDraftStreamMode(mode)
	};
}
function applyAppendOnlyStreamUpdate(params) {
	const incoming = params.incoming.trimEnd();
	if (!incoming) return {
		rendered: params.rendered,
		source: params.source,
		changed: false
	};
	if (!params.rendered) return {
		rendered: incoming,
		source: incoming,
		changed: true
	};
	if (incoming === params.source) return {
		rendered: params.rendered,
		source: params.source,
		changed: false
	};
	if (incoming.startsWith(params.source) || incoming.startsWith(params.rendered)) return {
		rendered: incoming,
		source: incoming,
		changed: incoming !== params.rendered
	};
	if (params.source.startsWith(incoming)) return {
		rendered: params.rendered,
		source: params.source,
		changed: false
	};
	const separator = params.rendered.endsWith("\n") ? "" : "\n";
	return {
		rendered: `${params.rendered}${separator}${incoming}`,
		source: incoming,
		changed: true
	};
}
function buildStatusFinalPreviewText(updateCount) {
	return `Status: thinking${".".repeat(Math.max(1, updateCount) % 3 + 1)}`;
}
//#endregion
//#region extensions/slack/src/streaming.ts
init_globals();
/**
* Start a new Slack text stream.
*
* Returns a {@link SlackStreamSession} that should be passed to
* {@link appendSlackStream} and {@link stopSlackStream}.
*
* The first chunk of text can optionally be included via `text`.
*/
async function startSlackStream(params) {
	const { client, channel, threadTs, text, teamId, userId } = params;
	logVerbose(`slack-stream: starting stream in ${channel} thread=${threadTs}${teamId ? ` team=${teamId}` : ""}${userId ? ` user=${userId}` : ""}`);
	const streamer = client.chatStream({
		channel,
		thread_ts: threadTs,
		...teamId ? { recipient_team_id: teamId } : {},
		...userId ? { recipient_user_id: userId } : {}
	});
	const session = {
		streamer,
		channel,
		threadTs,
		stopped: false
	};
	if (text) {
		await streamer.append({ markdown_text: text });
		logVerbose(`slack-stream: appended initial text (${text.length} chars)`);
	}
	return session;
}
/**
* Append markdown text to an active Slack stream.
*/
async function appendSlackStream(params) {
	const { session, text } = params;
	if (session.stopped) {
		logVerbose("slack-stream: attempted to append to a stopped stream, ignoring");
		return;
	}
	if (!text) return;
	await session.streamer.append({ markdown_text: text });
	logVerbose(`slack-stream: appended ${text.length} chars`);
}
/**
* Stop (finalize) a Slack stream.
*
* After calling this the stream message becomes a normal Slack message.
* Optionally include final text to append before stopping.
*/
async function stopSlackStream(params) {
	const { session, text } = params;
	if (session.stopped) {
		logVerbose("slack-stream: stream already stopped, ignoring duplicate stop");
		return;
	}
	session.stopped = true;
	logVerbose(`slack-stream: stopping stream in ${session.channel} thread=${session.threadTs}${text ? ` (final text: ${text.length} chars)` : ""}`);
	await session.streamer.stop(text ? { markdown_text: text } : void 0);
	logVerbose("slack-stream: stream stopped");
}
//#endregion
//#region extensions/slack/src/threading.ts
function resolveSlackThreadContext(params) {
	const incomingThreadTs = params.message.thread_ts;
	const eventTs = params.message.event_ts;
	const messageTs = params.message.ts ?? eventTs;
	const isThreadReply = typeof incomingThreadTs === "string" && incomingThreadTs.length > 0 && (incomingThreadTs !== messageTs || Boolean(params.message.parent_user_id));
	return {
		incomingThreadTs,
		messageTs,
		isThreadReply,
		replyToId: incomingThreadTs ?? messageTs,
		messageThreadId: isThreadReply ? incomingThreadTs : params.replyToMode === "all" ? messageTs : void 0
	};
}
/**
* Resolves Slack thread targeting for replies and status indicators.
*
* @returns replyThreadTs - Thread timestamp for reply messages
* @returns statusThreadTs - Thread timestamp for status indicators (typing, etc.)
* @returns isThreadReply - true if this is a genuine user reply in a thread,
*                          false if thread_ts comes from a bot status message (e.g. typing indicator)
*/
function resolveSlackThreadTargets(params) {
	const { incomingThreadTs, messageTs, isThreadReply } = resolveSlackThreadContext(params);
	const replyThreadTs = isThreadReply ? incomingThreadTs : params.replyToMode === "all" ? messageTs : void 0;
	return {
		replyThreadTs,
		statusThreadTs: replyThreadTs,
		isThreadReply
	};
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/dispatch.ts
init_globals();
function hasMedia(payload) {
	return Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
}
function isSlackStreamingEnabled(params) {
	if (params.mode !== "partial") return false;
	return params.nativeStreaming;
}
function resolveSlackStreamingThreadHint(params) {
	return resolveSlackThreadTs({
		replyToMode: params.replyToMode,
		incomingThreadTs: params.incomingThreadTs,
		messageTs: params.messageTs,
		hasReplied: false,
		isThreadReply: params.isThreadReply
	});
}
function shouldUseStreaming(params) {
	if (!params.streamingEnabled) return false;
	if (!params.threadTs) {
		logVerbose("slack-stream: streaming disabled — no reply thread target available");
		return false;
	}
	return true;
}
async function dispatchPreparedSlackMessage(prepared) {
	const { ctx, account, message, route } = prepared;
	const cfg = ctx.cfg;
	const runtime = ctx.runtime;
	const outboundIdentity = resolveAgentOutboundIdentity(cfg, route.agentId);
	const slackIdentity = outboundIdentity ? {
		username: outboundIdentity.name,
		iconUrl: outboundIdentity.avatarUrl,
		iconEmoji: outboundIdentity.emoji
	} : void 0;
	if (prepared.isDirectMessage) {
		const sessionCfg = cfg.session;
		const storePath = resolveStorePath(sessionCfg?.store, { agentId: route.agentId });
		const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
			dmScope: cfg.session?.dmScope,
			allowFrom: ctx.allowFrom,
			normalizeEntry: normalizeSlackAllowOwnerEntry
		});
		const senderRecipient = message.user?.trim().toLowerCase();
		if (pinnedMainDmOwner && senderRecipient && pinnedMainDmOwner.trim().toLowerCase() !== senderRecipient) logVerbose(`slack: skip main-session last route for ${senderRecipient} (pinned owner ${pinnedMainDmOwner})`);
		else await updateLastRoute({
			storePath,
			sessionKey: route.mainSessionKey,
			deliveryContext: {
				channel: "slack",
				to: `user:${message.user}`,
				accountId: route.accountId,
				threadId: prepared.ctxPayload.MessageThreadId
			},
			ctx: prepared.ctxPayload
		});
	}
	const { statusThreadTs, isThreadReply } = resolveSlackThreadTargets({
		message,
		replyToMode: prepared.replyToMode
	});
	const messageTs = message.ts ?? message.event_ts;
	const incomingThreadTs = message.thread_ts;
	let didSetStatus = false;
	const hasRepliedRef = { value: false };
	const replyPlan = createSlackReplyDeliveryPlan({
		replyToMode: prepared.replyToMode,
		incomingThreadTs,
		messageTs,
		hasRepliedRef,
		isThreadReply
	});
	const typingTarget = statusThreadTs ? `${message.channel}/${statusThreadTs}` : message.channel;
	const typingReaction = ctx.typingReaction;
	const typingCallbacks = createTypingCallbacks({
		start: async () => {
			didSetStatus = true;
			await ctx.setSlackThreadStatus({
				channelId: message.channel,
				threadTs: statusThreadTs,
				status: "is typing..."
			});
			if (typingReaction && message.ts) await reactSlackMessage(message.channel, message.ts, typingReaction, {
				token: ctx.botToken,
				client: ctx.app.client
			}).catch(() => {});
		},
		stop: async () => {
			if (!didSetStatus) return;
			didSetStatus = false;
			await ctx.setSlackThreadStatus({
				channelId: message.channel,
				threadTs: statusThreadTs,
				status: ""
			});
			if (typingReaction && message.ts) await removeSlackReaction(message.channel, message.ts, typingReaction, {
				token: ctx.botToken,
				client: ctx.app.client
			}).catch(() => {});
		},
		onStartError: (err) => {
			logTypingFailure({
				log: (message) => runtime.error?.(danger(message)),
				channel: "slack",
				action: "start",
				target: typingTarget,
				error: err
			});
		},
		onStopError: (err) => {
			logTypingFailure({
				log: (message) => runtime.error?.(danger(message)),
				channel: "slack",
				action: "stop",
				target: typingTarget,
				error: err
			});
		}
	});
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg,
		agentId: route.agentId,
		channel: "slack",
		accountId: route.accountId
	});
	const slackStreaming = resolveSlackStreamingConfig({
		streaming: account.config.streaming,
		streamMode: account.config.streamMode,
		nativeStreaming: account.config.nativeStreaming
	});
	const previewStreamingEnabled = slackStreaming.mode !== "off";
	const useStreaming = shouldUseStreaming({
		streamingEnabled: isSlackStreamingEnabled({
			mode: slackStreaming.mode,
			nativeStreaming: slackStreaming.nativeStreaming
		}),
		threadTs: resolveSlackStreamingThreadHint({
			replyToMode: prepared.replyToMode,
			incomingThreadTs,
			messageTs,
			isThreadReply
		})
	});
	let streamSession = null;
	let streamFailed = false;
	let usedReplyThreadTs;
	const deliverNormally = async (payload, forcedThreadTs) => {
		const replyThreadTs = forcedThreadTs ?? replyPlan.nextThreadTs();
		await deliverReplies({
			replies: [payload],
			target: prepared.replyTarget,
			token: ctx.botToken,
			accountId: account.accountId,
			runtime,
			textLimit: ctx.textLimit,
			replyThreadTs,
			replyToMode: prepared.replyToMode,
			...slackIdentity ? { identity: slackIdentity } : {}
		});
		if (replyThreadTs) usedReplyThreadTs ??= replyThreadTs;
		replyPlan.markSent();
	};
	const deliverWithStreaming = async (payload) => {
		if (streamFailed || hasMedia(payload) || readSlackReplyBlocks(payload)?.length || !payload.text?.trim()) {
			await deliverNormally(payload, streamSession?.threadTs);
			return;
		}
		const text = payload.text.trim();
		let plannedThreadTs;
		try {
			if (!streamSession) {
				const streamThreadTs = replyPlan.nextThreadTs();
				plannedThreadTs = streamThreadTs;
				if (!streamThreadTs) {
					logVerbose("slack-stream: no reply thread target for stream start, falling back to normal delivery");
					streamFailed = true;
					await deliverNormally(payload);
					return;
				}
				streamSession = await startSlackStream({
					client: ctx.app.client,
					channel: message.channel,
					threadTs: streamThreadTs,
					text,
					teamId: ctx.teamId,
					userId: message.user
				});
				usedReplyThreadTs ??= streamThreadTs;
				replyPlan.markSent();
				return;
			}
			await appendSlackStream({
				session: streamSession,
				text: "\n" + text
			});
		} catch (err) {
			runtime.error?.(danger(`slack-stream: streaming API call failed: ${String(err)}, falling back`));
			streamFailed = true;
			await deliverNormally(payload, streamSession?.threadTs ?? plannedThreadTs);
		}
	};
	const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
		...prefixOptions,
		humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
		typingCallbacks,
		deliver: async (payload) => {
			if (useStreaming) {
				await deliverWithStreaming(payload);
				return;
			}
			const mediaCount = payload.mediaUrls?.length ?? (payload.mediaUrl ? 1 : 0);
			const slackBlocks = readSlackReplyBlocks(payload);
			const draftMessageId = draftStream?.messageId();
			const draftChannelId = draftStream?.channelId();
			const trimmedFinalText = (payload.text ?? "").trim();
			if (previewStreamingEnabled && streamMode !== "status_final" && mediaCount === 0 && !payload.isError && (trimmedFinalText.length > 0 || Boolean(slackBlocks?.length)) && typeof draftMessageId === "string" && typeof draftChannelId === "string") {
				draftStream?.stop();
				try {
					await editSlackMessage(draftChannelId, draftMessageId, normalizeSlackOutboundText(trimmedFinalText), {
						token: ctx.botToken,
						accountId: account.accountId,
						client: ctx.app.client,
						...slackBlocks?.length ? { blocks: slackBlocks } : {}
					});
					return;
				} catch (err) {
					logVerbose(`slack: preview final edit failed; falling back to standard send (${String(err)})`);
				}
			} else if (previewStreamingEnabled && streamMode === "status_final" && hasStreamedMessage) try {
				const statusChannelId = draftStream?.channelId();
				const statusMessageId = draftStream?.messageId();
				if (statusChannelId && statusMessageId) await ctx.app.client.chat.update({
					token: ctx.botToken,
					channel: statusChannelId,
					ts: statusMessageId,
					text: "Status: complete. Final answer posted below."
				});
			} catch (err) {
				logVerbose(`slack: status_final completion update failed (${String(err)})`);
			}
			else if (mediaCount > 0) {
				await draftStream?.clear();
				hasStreamedMessage = false;
			}
			await deliverNormally(payload);
		},
		onError: (err, info) => {
			runtime.error?.(danger(`slack ${info.kind} reply failed: ${String(err)}`));
			typingCallbacks.onIdle?.();
		}
	});
	const draftStream = createSlackDraftStream({
		target: prepared.replyTarget,
		token: ctx.botToken,
		accountId: account.accountId,
		maxChars: Math.min(ctx.textLimit, 4e3),
		resolveThreadTs: () => {
			const ts = replyPlan.nextThreadTs();
			if (ts) usedReplyThreadTs ??= ts;
			return ts;
		},
		onMessageSent: () => replyPlan.markSent(),
		log: logVerbose,
		warn: logVerbose
	});
	let hasStreamedMessage = false;
	const streamMode = slackStreaming.draftMode;
	let appendRenderedText = "";
	let appendSourceText = "";
	let statusUpdateCount = 0;
	const updateDraftFromPartial = (text) => {
		const trimmed = text?.trimEnd();
		if (!trimmed) return;
		if (streamMode === "append") {
			const next = applyAppendOnlyStreamUpdate({
				incoming: trimmed,
				rendered: appendRenderedText,
				source: appendSourceText
			});
			appendRenderedText = next.rendered;
			appendSourceText = next.source;
			if (!next.changed) return;
			draftStream.update(next.rendered);
			hasStreamedMessage = true;
			return;
		}
		if (streamMode === "status_final") {
			statusUpdateCount += 1;
			if (statusUpdateCount > 1 && statusUpdateCount % 4 !== 0) return;
			draftStream.update(buildStatusFinalPreviewText(statusUpdateCount));
			hasStreamedMessage = true;
			return;
		}
		draftStream.update(trimmed);
		hasStreamedMessage = true;
	};
	const onDraftBoundary = useStreaming || !previewStreamingEnabled ? void 0 : async () => {
		if (hasStreamedMessage) {
			draftStream.forceNewMessage();
			hasStreamedMessage = false;
			appendRenderedText = "";
			appendSourceText = "";
			statusUpdateCount = 0;
		}
	};
	const { queuedFinal, counts } = await dispatchInboundMessage({
		ctx: prepared.ctxPayload,
		cfg,
		dispatcher,
		replyOptions: {
			...replyOptions,
			skillFilter: prepared.channelConfig?.skills,
			hasRepliedRef,
			disableBlockStreaming: useStreaming ? true : typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : void 0,
			onModelSelected,
			onPartialReply: useStreaming ? void 0 : !previewStreamingEnabled ? void 0 : async (payload) => {
				updateDraftFromPartial(payload.text);
			},
			onAssistantMessageStart: onDraftBoundary,
			onReasoningEnd: onDraftBoundary
		}
	});
	await draftStream.flush();
	draftStream.stop();
	markDispatchIdle();
	const finalStream = streamSession;
	if (finalStream && !finalStream.stopped) try {
		await stopSlackStream({ session: finalStream });
	} catch (err) {
		runtime.error?.(danger(`slack-stream: failed to stop stream: ${String(err)}`));
	}
	const anyReplyDelivered = queuedFinal || (counts.block ?? 0) > 0 || (counts.final ?? 0) > 0;
	const participationThreadTs = usedReplyThreadTs ?? statusThreadTs;
	if (anyReplyDelivered && participationThreadTs) recordSlackThreadParticipation(account.accountId, message.channel, participationThreadTs);
	if (!anyReplyDelivered) {
		await draftStream.clear();
		if (prepared.isRoomish) clearHistoryEntriesIfEnabled({
			historyMap: ctx.channelHistories,
			historyKey: prepared.historyKey,
			limit: ctx.historyLimit
		});
		return;
	}
	if (shouldLogVerbose()) {
		const finalCount = counts.final;
		logVerbose(`slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${prepared.replyTarget}`);
	}
	removeAckReactionAfterReply({
		removeAfterReply: ctx.removeAckAfterReply,
		ackReactionPromise: prepared.ackReactionPromise,
		ackReactionValue: prepared.ackReactionValue,
		remove: () => removeSlackReaction(message.channel, prepared.ackReactionMessageTs ?? "", prepared.ackReactionValue, {
			token: ctx.botToken,
			client: ctx.app.client
		}),
		onError: (err) => {
			logAckFailure({
				log: logVerbose,
				channel: "slack",
				target: `${message.channel}/${message.ts}`,
				error: err
			});
		}
	});
	if (prepared.isRoomish) clearHistoryEntriesIfEnabled({
		historyMap: ctx.channelHistories,
		historyKey: prepared.historyKey,
		limit: ctx.historyLimit
	});
}
//#endregion
//#region extensions/slack/src/monitor/dm-auth.ts
async function authorizeSlackDirectMessage(params) {
	if (!params.ctx.dmEnabled || params.ctx.dmPolicy === "disabled") {
		await params.onDisabled();
		return false;
	}
	if (params.ctx.dmPolicy === "open") return true;
	const senderName = (await params.resolveSenderName(params.senderId))?.name ?? void 0;
	const allowMatch = resolveSlackAllowListMatch({
		allowList: params.allowFromLower,
		id: params.senderId,
		name: senderName,
		allowNameMatching: params.ctx.allowNameMatching
	});
	const allowMatchMeta = formatAllowlistMatchMeta(allowMatch);
	if (allowMatch.allowed) return true;
	if (params.ctx.dmPolicy === "pairing") {
		await issuePairingChallenge({
			channel: "slack",
			senderId: params.senderId,
			senderIdLine: `Your Slack user id: ${params.senderId}`,
			meta: { name: senderName },
			upsertPairingRequest: async ({ id, meta }) => await upsertChannelPairingRequest({
				channel: "slack",
				id,
				accountId: params.accountId,
				meta
			}),
			sendPairingReply: params.sendPairingReply,
			onCreated: () => {
				params.log(`slack pairing request sender=${params.senderId} name=${senderName ?? "unknown"} (${allowMatchMeta})`);
			},
			onReplyError: (err) => {
				params.log(`slack pairing reply failed for ${params.senderId}: ${String(err)}`);
			}
		});
		return false;
	}
	await params.onUnauthorized({
		allowMatchMeta,
		senderName
	});
	return false;
}
//#endregion
//#region extensions/slack/src/monitor/room-context.ts
function resolveSlackRoomContextHints(params) {
	if (!params.isRoomish) return {};
	const untrustedChannelMetadata = buildUntrustedChannelMetadata({
		source: "slack",
		label: "Slack channel description",
		entries: [params.channelInfo?.topic, params.channelInfo?.purpose]
	});
	const systemPromptParts = [params.channelConfig?.systemPrompt?.trim() || null].filter((entry) => Boolean(entry));
	return {
		untrustedChannelMetadata,
		groupSystemPrompt: systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : void 0
	};
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/prepare-content.ts
init_globals();
function filterInheritedParentFiles(params) {
	const { files, isThreadReply, threadStarter } = params;
	if (!isThreadReply || !files?.length) return files;
	if (!threadStarter?.files?.length) return files;
	const starterFileIds = new Set(threadStarter.files.map((file) => file.id));
	const filtered = files.filter((file) => !file.id || !starterFileIds.has(file.id));
	if (filtered.length < files.length) logVerbose(`slack: filtered ${files.length - filtered.length} inherited parent file(s) from thread reply`);
	return filtered.length > 0 ? filtered : void 0;
}
async function resolveSlackMessageContent(params) {
	const ownFiles = filterInheritedParentFiles({
		files: params.message.files,
		isThreadReply: params.isThreadReply,
		threadStarter: params.threadStarter
	});
	const media = await resolveSlackMedia({
		files: ownFiles,
		token: params.botToken,
		maxBytes: params.mediaMaxBytes
	});
	const attachmentContent = await resolveSlackAttachmentContent({
		attachments: params.message.attachments,
		token: params.botToken,
		maxBytes: params.mediaMaxBytes
	});
	const mergedMedia = [...media ?? [], ...attachmentContent?.media ?? []];
	const effectiveDirectMedia = mergedMedia.length > 0 ? mergedMedia : null;
	const mediaPlaceholder = effectiveDirectMedia ? effectiveDirectMedia.map((item) => item.placeholder).join(" ") : void 0;
	const fallbackFiles = ownFiles ?? [];
	const fileOnlyFallback = !mediaPlaceholder && fallbackFiles.length > 0 ? fallbackFiles.slice(0, 8).map((file) => file.name?.trim() || "file").join(", ") : void 0;
	const fileOnlyPlaceholder = fileOnlyFallback ? `[Slack file: ${fileOnlyFallback}]` : void 0;
	const botAttachmentText = params.isBotMessage && !attachmentContent?.text ? (params.message.attachments ?? []).map((attachment) => attachment.text?.trim() || attachment.fallback?.trim()).filter(Boolean).join("\n") : void 0;
	const rawBody = [
		(params.message.text ?? "").trim(),
		attachmentContent?.text,
		botAttachmentText,
		mediaPlaceholder,
		fileOnlyPlaceholder
	].filter(Boolean).join("\n") || "";
	if (!rawBody) return null;
	return {
		rawBody,
		effectiveDirectMedia
	};
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/prepare-thread-context.ts
init_globals();
async function resolveSlackThreadContextData(params) {
	let threadStarterBody;
	let threadHistoryBody;
	let threadSessionPreviousTimestamp;
	let threadLabel;
	let threadStarterMedia = null;
	if (!params.isThreadReply || !params.threadTs) return {
		threadStarterBody,
		threadHistoryBody,
		threadSessionPreviousTimestamp,
		threadLabel,
		threadStarterMedia
	};
	const starter = params.threadStarter;
	if (starter?.text) {
		threadStarterBody = starter.text;
		const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
		threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
		if (!params.effectiveDirectMedia && starter.files && starter.files.length > 0) {
			threadStarterMedia = await resolveSlackMedia({
				files: starter.files,
				token: params.ctx.botToken,
				maxBytes: params.ctx.mediaMaxBytes
			});
			if (threadStarterMedia) logVerbose(`slack: hydrated thread starter file ${threadStarterMedia.map((item) => item.placeholder).join(", ")} from root message`);
		}
	} else threadLabel = `Slack thread ${params.roomLabel}`;
	const threadInitialHistoryLimit = params.account.config?.thread?.initialHistoryLimit ?? 20;
	threadSessionPreviousTimestamp = readSessionUpdatedAt({
		storePath: params.storePath,
		sessionKey: params.sessionKey
	});
	if (threadInitialHistoryLimit > 0 && !threadSessionPreviousTimestamp) {
		const threadHistory = await resolveSlackThreadHistory({
			channelId: params.message.channel,
			threadTs: params.threadTs,
			client: params.ctx.app.client,
			currentMessageTs: params.message.ts,
			limit: threadInitialHistoryLimit
		});
		if (threadHistory.length > 0) {
			const uniqueUserIds = [...new Set(threadHistory.map((item) => item.userId).filter((id) => Boolean(id)))];
			const userMap = /* @__PURE__ */ new Map();
			await Promise.all(uniqueUserIds.map(async (id) => {
				const user = await params.ctx.resolveUserName(id);
				if (user) userMap.set(id, user);
			}));
			const historyParts = [];
			for (const historyMsg of threadHistory) {
				const msgSenderName = (historyMsg.userId ? userMap.get(historyMsg.userId) : null)?.name ?? (historyMsg.botId ? `Bot (${historyMsg.botId})` : "Unknown");
				const role = Boolean(historyMsg.botId) ? "assistant" : "user";
				const msgWithId = `${historyMsg.text}\n[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${params.message.channel}]`;
				historyParts.push(formatInboundEnvelope({
					channel: "Slack",
					from: `${msgSenderName} (${role})`,
					timestamp: historyMsg.ts ? Math.round(Number(historyMsg.ts) * 1e3) : void 0,
					body: msgWithId,
					chatType: "channel",
					envelope: params.envelopeOptions
				}));
			}
			threadHistoryBody = historyParts.join("\n\n");
			logVerbose(`slack: populated thread history with ${threadHistory.length} messages for new session`);
		}
	}
	return {
		threadStarterBody,
		threadHistoryBody,
		threadSessionPreviousTimestamp,
		threadLabel,
		threadStarterMedia
	};
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/prepare.ts
init_globals();
init_session_key();
const mentionRegexCache = /* @__PURE__ */ new WeakMap();
function resolveCachedMentionRegexes(ctx, agentId) {
	const key = agentId?.trim() || "__default__";
	let byAgent = mentionRegexCache.get(ctx);
	if (!byAgent) {
		byAgent = /* @__PURE__ */ new Map();
		mentionRegexCache.set(ctx, byAgent);
	}
	const cached = byAgent.get(key);
	if (cached) return cached;
	const built = buildMentionRegexes(ctx.cfg, agentId);
	byAgent.set(key, built);
	return built;
}
async function resolveSlackConversationContext(params) {
	const { ctx, account, message } = params;
	const cfg = ctx.cfg;
	let channelInfo = {};
	let resolvedChannelType = normalizeSlackChannelType(message.channel_type, message.channel);
	if (resolvedChannelType !== "im" && (!message.channel_type || message.channel_type !== "im")) {
		channelInfo = await ctx.resolveChannelName(message.channel);
		resolvedChannelType = normalizeSlackChannelType(message.channel_type ?? channelInfo.type, message.channel);
	}
	const channelName = channelInfo?.name;
	const isDirectMessage = resolvedChannelType === "im";
	const isGroupDm = resolvedChannelType === "mpim";
	const isRoom = resolvedChannelType === "channel" || resolvedChannelType === "group";
	const isRoomish = isRoom || isGroupDm;
	const channelConfig = isRoom ? resolveSlackChannelConfig({
		channelId: message.channel,
		channelName,
		channels: ctx.channelsConfig,
		channelKeys: ctx.channelsConfigKeys,
		defaultRequireMention: ctx.defaultRequireMention,
		allowNameMatching: ctx.allowNameMatching
	}) : null;
	const allowBots = channelConfig?.allowBots ?? account.config?.allowBots ?? cfg.channels?.slack?.allowBots ?? false;
	return {
		channelInfo,
		channelName,
		resolvedChannelType,
		isDirectMessage,
		isGroupDm,
		isRoom,
		isRoomish,
		channelConfig,
		allowBots,
		isBotMessage: Boolean(message.bot_id)
	};
}
async function authorizeSlackInboundMessage(params) {
	const { ctx, account, message, conversation } = params;
	const { isDirectMessage, channelName, resolvedChannelType, isBotMessage, allowBots } = conversation;
	if (isBotMessage) {
		if (message.user && ctx.botUserId && message.user === ctx.botUserId) return null;
		if (!allowBots) {
			logVerbose(`slack: drop bot message ${message.bot_id ?? "unknown"} (allowBots=false)`);
			return null;
		}
	}
	if (isDirectMessage && !message.user) {
		logVerbose("slack: drop dm message (missing user id)");
		return null;
	}
	const senderId = message.user ?? (isBotMessage ? message.bot_id : void 0);
	if (!senderId) {
		logVerbose("slack: drop message (missing sender id)");
		return null;
	}
	if (!ctx.isChannelAllowed({
		channelId: message.channel,
		channelName,
		channelType: resolvedChannelType
	})) {
		logVerbose("slack: drop message (channel not allowed)");
		return null;
	}
	const { allowFromLower } = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: isDirectMessage });
	if (isDirectMessage) {
		const directUserId = message.user;
		if (!directUserId) {
			logVerbose("slack: drop dm message (missing user id)");
			return null;
		}
		if (!await authorizeSlackDirectMessage({
			ctx,
			accountId: account.accountId,
			senderId: directUserId,
			allowFromLower,
			resolveSenderName: ctx.resolveUserName,
			sendPairingReply: async (text) => {
				await sendMessageSlack(message.channel, text, {
					token: ctx.botToken,
					client: ctx.app.client,
					accountId: account.accountId
				});
			},
			onDisabled: () => {
				logVerbose("slack: drop dm (dms disabled)");
			},
			onUnauthorized: ({ allowMatchMeta }) => {
				logVerbose(`Blocked unauthorized slack sender ${message.user} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`);
			},
			log: logVerbose
		})) return null;
	}
	return {
		senderId,
		allowFromLower
	};
}
function resolveSlackRoutingContext(params) {
	const { ctx, account, message, isDirectMessage, isGroupDm, isRoom, isRoomish } = params;
	const route = resolveAgentRoute({
		cfg: ctx.cfg,
		channel: "slack",
		accountId: account.accountId,
		teamId: ctx.teamId || void 0,
		peer: {
			kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
			id: isDirectMessage ? message.user ?? "unknown" : message.channel
		}
	});
	const chatType = isDirectMessage ? "direct" : isGroupDm ? "group" : "channel";
	const replyToMode = resolveSlackReplyToMode(account, chatType);
	const threadContext = resolveSlackThreadContext({
		message,
		replyToMode
	});
	const threadTs = threadContext.incomingThreadTs;
	const isThreadReply = threadContext.isThreadReply;
	const autoThreadId = !isThreadReply && replyToMode === "all" && threadContext.messageTs ? threadContext.messageTs : void 0;
	const canonicalThreadId = isRoomish ? isThreadReply && threadTs ? threadTs : void 0 : isThreadReply ? threadTs : autoThreadId;
	const threadKeys = resolveThreadSessionKeys({
		baseSessionKey: route.sessionKey,
		threadId: canonicalThreadId,
		parentSessionKey: canonicalThreadId && ctx.threadInheritParent ? route.sessionKey : void 0
	});
	const sessionKey = threadKeys.sessionKey;
	return {
		route,
		chatType,
		replyToMode,
		threadContext,
		threadTs,
		isThreadReply,
		threadKeys,
		sessionKey,
		historyKey: isThreadReply && ctx.threadHistoryScope === "thread" ? sessionKey : message.channel
	};
}
async function prepareSlackMessage(params) {
	const { ctx, account, message, opts } = params;
	const cfg = ctx.cfg;
	const conversation = await resolveSlackConversationContext({
		ctx,
		account,
		message
	});
	const { channelInfo, channelName, isDirectMessage, isGroupDm, isRoom, isRoomish, channelConfig, isBotMessage } = conversation;
	const authorization = await authorizeSlackInboundMessage({
		ctx,
		account,
		message,
		conversation
	});
	if (!authorization) return null;
	const { senderId, allowFromLower } = authorization;
	const { route, replyToMode, threadContext, threadTs, isThreadReply, threadKeys, sessionKey, historyKey } = resolveSlackRoutingContext({
		ctx,
		account,
		message,
		isDirectMessage,
		isGroupDm,
		isRoom,
		isRoomish
	});
	const mentionRegexes = resolveCachedMentionRegexes(ctx, route.agentId);
	const hasAnyMention = /<@[^>]+>/.test(message.text ?? "");
	const explicitlyMentioned = Boolean(ctx.botUserId && message.text?.includes(`<@${ctx.botUserId}>`));
	const wasMentioned = opts.wasMentioned ?? (!isDirectMessage && matchesMentionWithExplicit({
		text: message.text ?? "",
		mentionRegexes,
		explicit: {
			hasAnyMention,
			isExplicitlyMentioned: explicitlyMentioned,
			canResolveExplicit: Boolean(ctx.botUserId)
		}
	}));
	const implicitMention = Boolean(!isDirectMessage && ctx.botUserId && message.thread_ts && (message.parent_user_id === ctx.botUserId || hasSlackThreadParticipation(account.accountId, message.channel, message.thread_ts)));
	let resolvedSenderName = message.username?.trim() || void 0;
	const resolveSenderName = async () => {
		if (resolvedSenderName) return resolvedSenderName;
		if (message.user) {
			const normalized = (await ctx.resolveUserName(message.user))?.name?.trim();
			if (normalized) {
				resolvedSenderName = normalized;
				return resolvedSenderName;
			}
		}
		resolvedSenderName = message.user ?? message.bot_id ?? "unknown";
		return resolvedSenderName;
	};
	const senderNameForAuth = ctx.allowNameMatching ? await resolveSenderName() : void 0;
	const channelUserAuthorized = isRoom ? resolveSlackUserAllowed({
		allowList: channelConfig?.users,
		userId: senderId,
		userName: senderNameForAuth,
		allowNameMatching: ctx.allowNameMatching
	}) : true;
	if (isRoom && !channelUserAuthorized) {
		logVerbose(`Blocked unauthorized slack sender ${senderId} (not in channel users)`);
		return null;
	}
	const allowTextCommands = shouldHandleTextCommands({
		cfg,
		surface: "slack"
	});
	const textForCommandDetection = stripSlackMentionsForCommandDetection(message.text ?? "");
	const hasControlCommandInMessage = hasControlCommand(textForCommandDetection, cfg);
	const ownerAuthorized = resolveSlackAllowListMatch({
		allowList: allowFromLower,
		id: senderId,
		name: senderNameForAuth,
		allowNameMatching: ctx.allowNameMatching
	}).allowed;
	const channelUsersAllowlistConfigured = isRoom && Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
	const channelCommandAuthorized = isRoom && channelUsersAllowlistConfigured ? resolveSlackUserAllowed({
		allowList: channelConfig?.users,
		userId: senderId,
		userName: senderNameForAuth,
		allowNameMatching: ctx.allowNameMatching
	}) : false;
	const commandGate = resolveControlCommandGate({
		useAccessGroups: ctx.useAccessGroups,
		authorizers: [{
			configured: allowFromLower.length > 0,
			allowed: ownerAuthorized
		}, {
			configured: channelUsersAllowlistConfigured,
			allowed: channelCommandAuthorized
		}],
		allowTextCommands,
		hasControlCommand: hasControlCommandInMessage
	});
	const commandAuthorized = commandGate.commandAuthorized;
	if (isRoomish && commandGate.shouldBlock) {
		logInboundDrop({
			log: logVerbose,
			channel: "slack",
			reason: "control command (unauthorized)",
			target: senderId
		});
		return null;
	}
	const shouldRequireMention = isRoom ? channelConfig?.requireMention ?? ctx.defaultRequireMention : false;
	const canDetectMention = Boolean(ctx.botUserId) || mentionRegexes.length > 0;
	const mentionGate = resolveMentionGatingWithBypass({
		isGroup: isRoom,
		requireMention: Boolean(shouldRequireMention),
		canDetectMention,
		wasMentioned,
		implicitMention,
		hasAnyMention,
		allowTextCommands,
		hasControlCommand: hasControlCommandInMessage,
		commandAuthorized
	});
	const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
	if (isRoom && shouldRequireMention && mentionGate.shouldSkip) {
		ctx.logger.info({
			channel: message.channel,
			reason: "no-mention"
		}, "skipping channel message");
		const pendingText = (message.text ?? "").trim();
		const fallbackFile = message.files?.[0]?.name ? `[Slack file: ${message.files[0].name}]` : message.files?.length ? "[Slack file]" : "";
		const pendingBody = pendingText || fallbackFile;
		recordPendingHistoryEntryIfEnabled({
			historyMap: ctx.channelHistories,
			historyKey,
			limit: ctx.historyLimit,
			entry: pendingBody ? {
				sender: await resolveSenderName(),
				body: pendingBody,
				timestamp: message.ts ? Math.round(Number(message.ts) * 1e3) : void 0,
				messageId: message.ts
			} : null
		});
		return null;
	}
	const threadStarter = isThreadReply && threadTs ? await resolveSlackThreadStarter({
		channelId: message.channel,
		threadTs,
		client: ctx.app.client
	}) : null;
	const resolvedMessageContent = await resolveSlackMessageContent({
		message,
		isThreadReply,
		threadStarter,
		isBotMessage,
		botToken: ctx.botToken,
		mediaMaxBytes: ctx.mediaMaxBytes
	});
	if (!resolvedMessageContent) return null;
	const { rawBody, effectiveDirectMedia } = resolvedMessageContent;
	const ackReaction = resolveAckReaction(cfg, route.agentId, {
		channel: "slack",
		accountId: account.accountId
	});
	const ackReactionValue = ackReaction ?? "";
	const shouldAckReaction$1 = () => Boolean(ackReaction && shouldAckReaction({
		scope: ctx.ackReactionScope,
		isDirect: isDirectMessage,
		isGroup: isRoomish,
		isMentionableGroup: isRoom,
		requireMention: Boolean(shouldRequireMention),
		canDetectMention,
		effectiveWasMentioned,
		shouldBypassMention: mentionGate.shouldBypassMention
	}));
	const ackReactionMessageTs = message.ts;
	const ackReactionPromise = shouldAckReaction$1() && ackReactionMessageTs && ackReactionValue ? reactSlackMessage(message.channel, ackReactionMessageTs, ackReactionValue, {
		token: ctx.botToken,
		client: ctx.app.client
	}).then(() => true, (err) => {
		logVerbose(`slack react failed for channel ${message.channel}: ${String(err)}`);
		return false;
	}) : null;
	const roomLabel = channelName ? `#${channelName}` : `#${message.channel}`;
	const senderName = await resolveSenderName();
	const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
	const inboundLabel = isDirectMessage ? `Slack DM from ${senderName}` : `Slack message in ${roomLabel} from ${senderName}`;
	const slackFrom = isDirectMessage ? `slack:${message.user}` : isRoom ? `slack:channel:${message.channel}` : `slack:group:${message.channel}`;
	enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
		sessionKey,
		contextKey: `slack:message:${message.channel}:${message.ts ?? "unknown"}`
	});
	const envelopeFrom = resolveConversationLabel({
		ChatType: isDirectMessage ? "direct" : "channel",
		SenderName: senderName,
		GroupSubject: isRoomish ? roomLabel : void 0,
		From: slackFrom
	}) ?? (isDirectMessage ? senderName : roomLabel);
	const threadInfo = isThreadReply && threadTs ? ` thread_ts: ${threadTs}${message.parent_user_id ? ` parent_user_id: ${message.parent_user_id}` : ""}` : "";
	const textWithId = `${rawBody}\n[slack message id: ${message.ts} channel: ${message.channel}${threadInfo}]`;
	const storePath = resolveStorePath(ctx.cfg.session?.store, { agentId: route.agentId });
	const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
	const previousTimestamp = readSessionUpdatedAt({
		storePath,
		sessionKey
	});
	let combinedBody = formatInboundEnvelope({
		channel: "Slack",
		from: envelopeFrom,
		timestamp: message.ts ? Math.round(Number(message.ts) * 1e3) : void 0,
		body: textWithId,
		chatType: isDirectMessage ? "direct" : "channel",
		sender: {
			name: senderName,
			id: senderId
		},
		previousTimestamp,
		envelope: envelopeOptions
	});
	if (isRoomish && ctx.historyLimit > 0) combinedBody = buildPendingHistoryContextFromMap({
		historyMap: ctx.channelHistories,
		historyKey,
		limit: ctx.historyLimit,
		currentMessage: combinedBody,
		formatEntry: (entry) => formatInboundEnvelope({
			channel: "Slack",
			from: roomLabel,
			timestamp: entry.timestamp,
			body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId} channel:${message.channel}]` : ""}`,
			chatType: "channel",
			senderLabel: entry.sender,
			envelope: envelopeOptions
		})
	});
	const slackTo = isDirectMessage ? `user:${message.user}` : `channel:${message.channel}`;
	const { untrustedChannelMetadata, groupSystemPrompt } = resolveSlackRoomContextHints({
		isRoomish,
		channelInfo,
		channelConfig
	});
	const { threadStarterBody, threadHistoryBody, threadSessionPreviousTimestamp, threadLabel, threadStarterMedia } = await resolveSlackThreadContextData({
		ctx,
		account,
		message,
		isThreadReply,
		threadTs,
		threadStarter,
		roomLabel,
		storePath,
		sessionKey,
		envelopeOptions,
		effectiveDirectMedia
	});
	const effectiveMedia = effectiveDirectMedia ?? threadStarterMedia;
	const firstMedia = effectiveMedia?.[0];
	const inboundHistory = isRoomish && ctx.historyLimit > 0 ? (ctx.channelHistories.get(historyKey) ?? []).map((entry) => ({
		sender: entry.sender,
		body: entry.body,
		timestamp: entry.timestamp
	})) : void 0;
	const commandBody = textForCommandDetection.trim();
	const ctxPayload = finalizeInboundContext({
		Body: combinedBody,
		BodyForAgent: rawBody,
		InboundHistory: inboundHistory,
		RawBody: rawBody,
		CommandBody: commandBody,
		BodyForCommands: commandBody,
		From: slackFrom,
		To: slackTo,
		SessionKey: sessionKey,
		AccountId: route.accountId,
		ChatType: isDirectMessage ? "direct" : "channel",
		ConversationLabel: envelopeFrom,
		GroupSubject: isRoomish ? roomLabel : void 0,
		GroupSystemPrompt: isRoomish ? groupSystemPrompt : void 0,
		UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : void 0,
		SenderName: senderName,
		SenderId: senderId,
		Provider: "slack",
		Surface: "slack",
		MessageSid: message.ts,
		ReplyToId: threadContext.replyToId,
		MessageThreadId: threadContext.messageThreadId,
		ParentSessionKey: threadKeys.parentSessionKey,
		ThreadStarterBody: !threadSessionPreviousTimestamp ? threadStarterBody : void 0,
		ThreadHistoryBody: threadHistoryBody,
		IsFirstThreadTurn: isThreadReply && threadTs && !threadSessionPreviousTimestamp ? true : void 0,
		ThreadLabel: threadLabel,
		Timestamp: message.ts ? Math.round(Number(message.ts) * 1e3) : void 0,
		WasMentioned: isRoomish ? effectiveWasMentioned : void 0,
		MediaPath: firstMedia?.path,
		MediaType: firstMedia?.contentType,
		MediaUrl: firstMedia?.path,
		MediaPaths: effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.path) : void 0,
		MediaUrls: effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.path) : void 0,
		MediaTypes: effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.contentType ?? "") : void 0,
		CommandAuthorized: commandAuthorized,
		OriginatingChannel: "slack",
		OriginatingTo: slackTo,
		NativeChannelId: message.channel
	});
	const pinnedMainDmOwner = isDirectMessage ? resolvePinnedMainDmOwnerFromAllowlist({
		dmScope: cfg.session?.dmScope,
		allowFrom: ctx.allowFrom,
		normalizeEntry: normalizeSlackAllowOwnerEntry
	}) : null;
	await recordInboundSession({
		storePath,
		sessionKey,
		ctx: ctxPayload,
		updateLastRoute: isDirectMessage ? {
			sessionKey: route.mainSessionKey,
			channel: "slack",
			to: `user:${message.user}`,
			accountId: route.accountId,
			threadId: threadContext.messageThreadId,
			mainDmOwnerPin: pinnedMainDmOwner && message.user ? {
				ownerRecipient: pinnedMainDmOwner,
				senderRecipient: message.user.toLowerCase(),
				onSkip: ({ ownerRecipient, senderRecipient }) => {
					logVerbose(`slack: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`);
				}
			} : void 0
		} : void 0,
		onRecordError: (err) => {
			ctx.logger.warn({
				error: String(err),
				storePath,
				sessionKey
			}, "failed updating session meta");
		}
	});
	const replyTarget = ctxPayload.To ?? void 0;
	if (!replyTarget) return null;
	if (shouldLogVerbose()) logVerbose(`slack inbound: channel=${message.channel} from=${slackFrom} preview="${preview}"`);
	return {
		ctx,
		account,
		message,
		route,
		channelConfig,
		replyTarget,
		ctxPayload,
		replyToMode,
		isDirectMessage,
		isRoomish,
		historyKey,
		preview,
		ackReactionMessageTs,
		ackReactionValue,
		ackReactionPromise
	};
}
//#endregion
//#region extensions/slack/src/monitor/thread-resolution.ts
init_globals();
const DEFAULT_THREAD_TS_CACHE_TTL_MS = 6e4;
const DEFAULT_THREAD_TS_CACHE_MAX = 500;
const normalizeThreadTs = (threadTs) => {
	const trimmed = threadTs?.trim();
	return trimmed ? trimmed : void 0;
};
async function resolveThreadTsFromHistory(params) {
	try {
		const response = await params.client.conversations.history({
			channel: params.channelId,
			latest: params.messageTs,
			oldest: params.messageTs,
			inclusive: true,
			limit: 1
		});
		return normalizeThreadTs((response.messages?.find((entry) => entry.ts === params.messageTs) ?? response.messages?.[0])?.thread_ts);
	} catch (err) {
		if (shouldLogVerbose()) logVerbose(`slack inbound: failed to resolve thread_ts via conversations.history for channel=${params.channelId} ts=${params.messageTs}: ${String(err)}`);
		return;
	}
}
function createSlackThreadTsResolver(params) {
	const ttlMs = Math.max(0, params.cacheTtlMs ?? DEFAULT_THREAD_TS_CACHE_TTL_MS);
	const maxSize = Math.max(0, params.maxSize ?? DEFAULT_THREAD_TS_CACHE_MAX);
	const cache = /* @__PURE__ */ new Map();
	const inflight = /* @__PURE__ */ new Map();
	const getCached = (key, now) => {
		const entry = cache.get(key);
		if (!entry) return;
		if (ttlMs > 0 && now - entry.updatedAt > ttlMs) {
			cache.delete(key);
			return;
		}
		cache.delete(key);
		cache.set(key, {
			...entry,
			updatedAt: now
		});
		return entry.threadTs;
	};
	const setCached = (key, threadTs, now) => {
		cache.delete(key);
		cache.set(key, {
			threadTs,
			updatedAt: now
		});
		pruneMapToMaxSize(cache, maxSize);
	};
	return { resolve: async (request) => {
		const { message } = request;
		if (!message.parent_user_id || message.thread_ts || !message.ts) return message;
		const cacheKey = `${message.channel}:${message.ts}`;
		const cached = getCached(cacheKey, Date.now());
		if (cached !== void 0) return cached ? {
			...message,
			thread_ts: cached
		} : message;
		if (shouldLogVerbose()) logVerbose(`slack inbound: missing thread_ts for thread reply channel=${message.channel} ts=${message.ts} source=${request.source}`);
		let pending = inflight.get(cacheKey);
		if (!pending) {
			pending = resolveThreadTsFromHistory({
				client: params.client,
				channelId: message.channel,
				messageTs: message.ts
			});
			inflight.set(cacheKey, pending);
		}
		let resolved;
		try {
			resolved = await pending;
		} finally {
			inflight.delete(cacheKey);
		}
		setCached(cacheKey, resolved ?? null, Date.now());
		if (resolved) {
			if (shouldLogVerbose()) logVerbose(`slack inbound: resolved missing thread_ts channel=${message.channel} ts=${message.ts} -> thread_ts=${resolved}`);
			return {
				...message,
				thread_ts: resolved
			};
		}
		if (shouldLogVerbose()) logVerbose(`slack inbound: could not resolve missing thread_ts channel=${message.channel} ts=${message.ts}`);
		return message;
	} };
}
//#endregion
//#region extensions/slack/src/monitor/message-handler.ts
const APP_MENTION_RETRY_TTL_MS = 6e4;
function resolveSlackSenderId(message) {
	return message.user ?? message.bot_id ?? null;
}
function isSlackDirectMessageChannel(channelId) {
	return channelId.startsWith("D");
}
function isTopLevelSlackMessage(message) {
	return !message.thread_ts && !message.parent_user_id;
}
function buildTopLevelSlackConversationKey(message, accountId) {
	if (!isTopLevelSlackMessage(message)) return null;
	const senderId = resolveSlackSenderId(message);
	if (!senderId) return null;
	return `slack:${accountId}:${message.channel}:${senderId}`;
}
function shouldDebounceSlackMessage(message, cfg) {
	return shouldDebounceTextInbound({
		text: stripSlackMentionsForCommandDetection(message.text ?? ""),
		cfg,
		hasMedia: Boolean(message.files && message.files.length > 0)
	});
}
function buildSeenMessageKey(channelId, ts) {
	if (!channelId || !ts) return null;
	return `${channelId}:${ts}`;
}
/**
* Build a debounce key that isolates messages by thread (or by message timestamp
* for top-level non-DM channel messages). Without per-message scoping, concurrent
* top-level messages from the same sender can share a key and get merged
* into a single reply on the wrong thread.
*
* DMs intentionally stay channel-scoped to preserve short-message batching.
*/
function buildSlackDebounceKey(message, accountId) {
	const senderId = resolveSlackSenderId(message);
	if (!senderId) return null;
	const messageTs = message.ts ?? message.event_ts;
	return `slack:${accountId}:${message.thread_ts ? `${message.channel}:${message.thread_ts}` : message.parent_user_id && messageTs ? `${message.channel}:maybe-thread:${messageTs}` : messageTs && !isSlackDirectMessageChannel(message.channel) ? `${message.channel}:${messageTs}` : message.channel}:${senderId}`;
}
function createSlackMessageHandler(params) {
	const { ctx, account, trackEvent } = params;
	const { debounceMs, debouncer } = createChannelInboundDebouncer({
		cfg: ctx.cfg,
		channel: "slack",
		buildKey: (entry) => buildSlackDebounceKey(entry.message, ctx.accountId),
		shouldDebounce: (entry) => shouldDebounceSlackMessage(entry.message, ctx.cfg),
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) return;
			const flushedKey = buildSlackDebounceKey(last.message, ctx.accountId);
			const topLevelConversationKey = buildTopLevelSlackConversationKey(last.message, ctx.accountId);
			if (flushedKey && topLevelConversationKey) {
				const pendingKeys = pendingTopLevelDebounceKeys.get(topLevelConversationKey);
				if (pendingKeys) {
					pendingKeys.delete(flushedKey);
					if (pendingKeys.size === 0) pendingTopLevelDebounceKeys.delete(topLevelConversationKey);
				}
			}
			const combinedText = entries.length === 1 ? last.message.text ?? "" : entries.map((entry) => entry.message.text ?? "").filter(Boolean).join("\n");
			const combinedMentioned = entries.some((entry) => Boolean(entry.opts.wasMentioned));
			const prepared = await prepareSlackMessage({
				ctx,
				account,
				message: {
					...last.message,
					text: combinedText
				},
				opts: {
					...last.opts,
					wasMentioned: combinedMentioned || last.opts.wasMentioned
				}
			});
			const seenMessageKey = buildSeenMessageKey(last.message.channel, last.message.ts);
			if (!prepared) return;
			if (seenMessageKey) {
				pruneAppMentionRetryKeys(Date.now());
				if (last.opts.source === "app_mention") appMentionDispatchedKeys.set(seenMessageKey, Date.now() + APP_MENTION_RETRY_TTL_MS);
				else if (last.opts.source === "message" && appMentionDispatchedKeys.has(seenMessageKey)) {
					appMentionDispatchedKeys.delete(seenMessageKey);
					appMentionRetryKeys.delete(seenMessageKey);
					return;
				}
				appMentionRetryKeys.delete(seenMessageKey);
			}
			if (entries.length > 1) {
				const ids = entries.map((entry) => entry.message.ts).filter(Boolean);
				if (ids.length > 0) {
					prepared.ctxPayload.MessageSids = ids;
					prepared.ctxPayload.MessageSidFirst = ids[0];
					prepared.ctxPayload.MessageSidLast = ids[ids.length - 1];
				}
			}
			await dispatchPreparedSlackMessage(prepared);
		},
		onError: (err) => {
			ctx.runtime.error?.(`slack inbound debounce flush failed: ${String(err)}`);
		}
	});
	const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });
	const pendingTopLevelDebounceKeys = /* @__PURE__ */ new Map();
	const appMentionRetryKeys = /* @__PURE__ */ new Map();
	const appMentionDispatchedKeys = /* @__PURE__ */ new Map();
	const pruneAppMentionRetryKeys = (now) => {
		for (const [key, expiresAt] of appMentionRetryKeys) if (expiresAt <= now) appMentionRetryKeys.delete(key);
		for (const [key, expiresAt] of appMentionDispatchedKeys) if (expiresAt <= now) appMentionDispatchedKeys.delete(key);
	};
	const rememberAppMentionRetryKey = (key) => {
		const now = Date.now();
		pruneAppMentionRetryKeys(now);
		appMentionRetryKeys.set(key, now + APP_MENTION_RETRY_TTL_MS);
	};
	const consumeAppMentionRetryKey = (key) => {
		pruneAppMentionRetryKeys(Date.now());
		if (!appMentionRetryKeys.has(key)) return false;
		appMentionRetryKeys.delete(key);
		return true;
	};
	return async (message, opts) => {
		if (opts.source === "message" && message.type !== "message") return;
		if (opts.source === "message" && message.subtype && message.subtype !== "file_share" && message.subtype !== "bot_message") return;
		const seenMessageKey = buildSeenMessageKey(message.channel, message.ts);
		const wasSeen = seenMessageKey ? ctx.markMessageSeen(message.channel, message.ts) : false;
		if (seenMessageKey && opts.source === "message" && !wasSeen) rememberAppMentionRetryKey(seenMessageKey);
		if (seenMessageKey && wasSeen) {
			if (opts.source !== "app_mention" || !consumeAppMentionRetryKey(seenMessageKey)) return;
		}
		trackEvent?.();
		const resolvedMessage = await threadTsResolver.resolve({
			message,
			source: opts.source
		});
		const debounceKey = buildSlackDebounceKey(resolvedMessage, ctx.accountId);
		const conversationKey = buildTopLevelSlackConversationKey(resolvedMessage, ctx.accountId);
		const canDebounce = debounceMs > 0 && shouldDebounceSlackMessage(resolvedMessage, ctx.cfg);
		if (!canDebounce && conversationKey) {
			const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey);
			if (pendingKeys && pendingKeys.size > 0) {
				const keysToFlush = Array.from(pendingKeys);
				for (const pendingKey of keysToFlush) await debouncer.flushKey(pendingKey);
			}
		}
		if (canDebounce && debounceKey && conversationKey) {
			const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey) ?? /* @__PURE__ */ new Set();
			pendingKeys.add(debounceKey);
			pendingTopLevelDebounceKeys.set(conversationKey, pendingKeys);
		}
		await debouncer.enqueue({
			message: resolvedMessage,
			opts
		});
	};
}
//#endregion
//#region extensions/slack/src/monitor/reconnect-policy.ts
const SLACK_AUTH_ERROR_RE = /account_inactive|invalid_auth|token_revoked|token_expired|not_authed|org_login_required|team_access_not_granted|missing_scope|cannot_find_service|invalid_token/i;
const SLACK_SOCKET_RECONNECT_POLICY = {
	initialMs: 2e3,
	maxMs: 3e4,
	factor: 1.8,
	jitter: .25,
	maxAttempts: 12
};
function getSocketEmitter(app) {
	const receiver = app.receiver;
	const client = receiver && typeof receiver === "object" ? receiver.client : void 0;
	if (!client || typeof client !== "object") return null;
	const on = client.on;
	const off = client.off;
	if (typeof on !== "function" || typeof off !== "function") return null;
	return {
		on: (event, listener) => on.call(client, event, listener),
		off: (event, listener) => off.call(client, event, listener)
	};
}
function waitForSlackSocketDisconnect(app, abortSignal) {
	return new Promise((resolve) => {
		const emitter = getSocketEmitter(app);
		if (!emitter) {
			abortSignal?.addEventListener("abort", () => resolve({ event: "disconnect" }), { once: true });
			return;
		}
		const disconnectListener = () => resolveOnce({ event: "disconnect" });
		const startFailListener = (error) => resolveOnce({
			event: "unable_to_socket_mode_start",
			error
		});
		const errorListener = (error) => resolveOnce({
			event: "error",
			error
		});
		const abortListener = () => resolveOnce({ event: "disconnect" });
		const cleanup = () => {
			emitter.off("disconnected", disconnectListener);
			emitter.off("unable_to_socket_mode_start", startFailListener);
			emitter.off("error", errorListener);
			abortSignal?.removeEventListener("abort", abortListener);
		};
		const resolveOnce = (value) => {
			cleanup();
			resolve(value);
		};
		emitter.on("disconnected", disconnectListener);
		emitter.on("unable_to_socket_mode_start", startFailListener);
		emitter.on("error", errorListener);
		abortSignal?.addEventListener("abort", abortListener, { once: true });
	});
}
/**
* Detect non-recoverable Slack API / auth errors that should NOT be retried.
* These indicate permanent credential problems (revoked bot, deactivated account, etc.)
* and retrying will never succeed — continuing to retry blocks the entire gateway.
*/
function isNonRecoverableSlackAuthError(error) {
	const msg = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return SLACK_AUTH_ERROR_RE.test(msg);
}
function formatUnknownError(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return "unknown error";
	}
}
//#endregion
//#region extensions/slack/src/monitor/external-arg-menu-store.ts
const SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES = 18;
const SLACK_EXTERNAL_ARG_MENU_TOKEN_LENGTH = Math.ceil(SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES * 8 / 6);
const SLACK_EXTERNAL_ARG_MENU_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${SLACK_EXTERNAL_ARG_MENU_TOKEN_LENGTH}}$`);
const SLACK_EXTERNAL_ARG_MENU_TTL_MS = 600 * 1e3;
const SLACK_EXTERNAL_ARG_MENU_PREFIX = "openclaw_cmdarg_ext:";
function pruneSlackExternalArgMenuStore(store, now) {
	for (const [token, entry] of store.entries()) if (entry.expiresAt <= now) store.delete(token);
}
function createSlackExternalArgMenuToken(store) {
	let token = "";
	do
		token = generateSecureToken(SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES);
	while (store.has(token));
	return token;
}
function createSlackExternalArgMenuStore() {
	const store = /* @__PURE__ */ new Map();
	return {
		create(params, now = Date.now()) {
			pruneSlackExternalArgMenuStore(store, now);
			const token = createSlackExternalArgMenuToken(store);
			store.set(token, {
				choices: params.choices,
				userId: params.userId,
				expiresAt: now + SLACK_EXTERNAL_ARG_MENU_TTL_MS
			});
			return token;
		},
		readToken(raw) {
			if (typeof raw !== "string" || !raw.startsWith("openclaw_cmdarg_ext:")) return;
			const token = raw.slice(20).trim();
			return SLACK_EXTERNAL_ARG_MENU_TOKEN_PATTERN.test(token) ? token : void 0;
		},
		get(token, now = Date.now()) {
			pruneSlackExternalArgMenuStore(store, now);
			return store.get(token);
		}
	};
}
//#endregion
//#region extensions/slack/src/monitor/slash.ts
init_globals();
const SLACK_COMMAND_ARG_ACTION_ID = "openclaw_cmdarg";
const SLACK_COMMAND_ARG_VALUE_PREFIX = "cmdarg";
const SLACK_COMMAND_ARG_BUTTON_ROW_SIZE = 5;
const SLACK_COMMAND_ARG_OVERFLOW_MIN = 3;
const SLACK_COMMAND_ARG_OVERFLOW_MAX = 5;
const SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX = 100;
const SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX = 75;
const SLACK_HEADER_TEXT_MAX = 150;
let slashCommandsRuntimePromise = null;
let slashDispatchRuntimePromise = null;
let slashSkillCommandsRuntimePromise = null;
function loadSlashCommandsRuntime() {
	slashCommandsRuntimePromise ??= import("./slash-commands.runtime-BpZbV2Oi.js");
	return slashCommandsRuntimePromise;
}
function loadSlashDispatchRuntime() {
	slashDispatchRuntimePromise ??= import("./slash-dispatch.runtime-CgQM6PB1.js");
	return slashDispatchRuntimePromise;
}
function loadSlashSkillCommandsRuntime() {
	slashSkillCommandsRuntimePromise ??= import("./slash-skill-commands.runtime-DB78c1FM.js");
	return slashSkillCommandsRuntimePromise;
}
const slackExternalArgMenuStore = createSlackExternalArgMenuStore();
function buildSlackArgMenuConfirm(params) {
	return {
		title: {
			type: "plain_text",
			text: "Confirm selection"
		},
		text: {
			type: "mrkdwn",
			text: `Run */${escapeSlackMrkdwn(params.command)}* with *${escapeSlackMrkdwn(params.arg)}* set to this value?`
		},
		confirm: {
			type: "plain_text",
			text: "Run command"
		},
		deny: {
			type: "plain_text",
			text: "Cancel"
		}
	};
}
function storeSlackExternalArgMenu(params) {
	return slackExternalArgMenuStore.create({
		choices: params.choices,
		userId: params.userId
	});
}
function readSlackExternalArgMenuToken(raw) {
	return slackExternalArgMenuStore.readToken(raw);
}
function encodeSlackCommandArgValue(parts) {
	return [
		SLACK_COMMAND_ARG_VALUE_PREFIX,
		encodeURIComponent(parts.command),
		encodeURIComponent(parts.arg),
		encodeURIComponent(parts.value),
		encodeURIComponent(parts.userId)
	].join("|");
}
function parseSlackCommandArgValue(raw) {
	if (!raw) return null;
	const parts = raw.split("|");
	if (parts.length !== 5 || parts[0] !== SLACK_COMMAND_ARG_VALUE_PREFIX) return null;
	const [, command, arg, value, userId] = parts;
	if (!command || !arg || !value || !userId) return null;
	const decode = (text) => {
		try {
			return decodeURIComponent(text);
		} catch {
			return null;
		}
	};
	const decodedCommand = decode(command);
	const decodedArg = decode(arg);
	const decodedValue = decode(value);
	const decodedUserId = decode(userId);
	if (!decodedCommand || !decodedArg || !decodedValue || !decodedUserId) return null;
	return {
		command: decodedCommand,
		arg: decodedArg,
		value: decodedValue,
		userId: decodedUserId
	};
}
function buildSlackArgMenuOptions(choices) {
	return choices.map((choice) => ({
		text: {
			type: "plain_text",
			text: choice.label.slice(0, 75)
		},
		value: choice.value
	}));
}
function buildSlackCommandArgMenuBlocks(params) {
	const encodedChoices = params.choices.map((choice) => ({
		label: choice.label,
		value: encodeSlackCommandArgValue({
			command: params.command,
			arg: params.arg,
			value: choice.value,
			userId: params.userId
		})
	}));
	const canUseStaticSelect = encodedChoices.every((choice) => choice.value.length <= SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX);
	const canUseOverflow = canUseStaticSelect && encodedChoices.length >= SLACK_COMMAND_ARG_OVERFLOW_MIN && encodedChoices.length <= SLACK_COMMAND_ARG_OVERFLOW_MAX;
	const canUseExternalSelect = params.supportsExternalSelect && canUseStaticSelect && encodedChoices.length > SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX;
	const rows = canUseOverflow ? [{
		type: "actions",
		elements: [{
			type: "overflow",
			action_id: SLACK_COMMAND_ARG_ACTION_ID,
			confirm: buildSlackArgMenuConfirm({
				command: params.command,
				arg: params.arg
			}),
			options: buildSlackArgMenuOptions(encodedChoices)
		}]
	}] : canUseExternalSelect ? [{
		type: "actions",
		block_id: `${SLACK_EXTERNAL_ARG_MENU_PREFIX}${params.createExternalMenuToken(encodedChoices)}`,
		elements: [{
			type: "external_select",
			action_id: SLACK_COMMAND_ARG_ACTION_ID,
			confirm: buildSlackArgMenuConfirm({
				command: params.command,
				arg: params.arg
			}),
			min_query_length: 0,
			placeholder: {
				type: "plain_text",
				text: `Search ${params.arg}`
			}
		}]
	}] : encodedChoices.length <= SLACK_COMMAND_ARG_BUTTON_ROW_SIZE || !canUseStaticSelect ? chunkItems(encodedChoices, SLACK_COMMAND_ARG_BUTTON_ROW_SIZE).map((choices) => ({
		type: "actions",
		elements: choices.map((choice) => ({
			type: "button",
			action_id: SLACK_COMMAND_ARG_ACTION_ID,
			text: {
				type: "plain_text",
				text: choice.label
			},
			value: choice.value,
			confirm: buildSlackArgMenuConfirm({
				command: params.command,
				arg: params.arg
			})
		}))
	})) : chunkItems(encodedChoices, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX).map((choices, index) => ({
		type: "actions",
		elements: [{
			type: "static_select",
			action_id: SLACK_COMMAND_ARG_ACTION_ID,
			confirm: buildSlackArgMenuConfirm({
				command: params.command,
				arg: params.arg
			}),
			placeholder: {
				type: "plain_text",
				text: index === 0 ? `Choose ${params.arg}` : `Choose ${params.arg} (${index + 1})`
			},
			options: buildSlackArgMenuOptions(choices)
		}]
	}));
	const headerText = truncateSlackText(`/${params.command}: choose ${params.arg}`, SLACK_HEADER_TEXT_MAX);
	const sectionText = truncateSlackText(params.title, 3e3);
	const contextText = truncateSlackText(`Select one option to continue /${params.command} (${params.arg})`, 3e3);
	return [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: headerText
			}
		},
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: sectionText
			}
		},
		{
			type: "context",
			elements: [{
				type: "mrkdwn",
				text: contextText
			}]
		},
		...rows
	];
}
async function registerSlackMonitorSlashCommands(params) {
	const { ctx, account } = params;
	const cfg = ctx.cfg;
	const runtime = ctx.runtime;
	const supportsInteractiveArgMenus = typeof ctx.app.action === "function";
	let supportsExternalArgMenus = typeof ctx.app.options === "function";
	const slashCommand = resolveSlackSlashCommandConfig(ctx.slashCommand ?? account.config.slashCommand);
	const handleSlashCommand = async (p) => {
		const { command, ack, respond, body, prompt, commandArgs, commandDefinition } = p;
		try {
			if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
				await ack();
				runtime.log?.(`slack: drop slash command from user=${command.user_id ?? "unknown"} channel=${command.channel_id ?? "unknown"} (mismatched app/team)`);
				return;
			}
			if (!prompt.trim()) {
				await ack({
					text: "Message required.",
					response_type: "ephemeral"
				});
				return;
			}
			await ack();
			if (ctx.botUserId && command.user_id === ctx.botUserId) return;
			const channelInfo = await ctx.resolveChannelName(command.channel_id);
			const channelType = normalizeSlackChannelType(channelInfo?.type ?? (command.channel_name === "directmessage" ? "im" : void 0), command.channel_id);
			const isDirectMessage = channelType === "im";
			const isGroupDm = channelType === "mpim";
			const isRoom = channelType === "channel" || channelType === "group";
			const isRoomish = isRoom || isGroupDm;
			if (!ctx.isChannelAllowed({
				channelId: command.channel_id,
				channelName: channelInfo?.name,
				channelType
			})) {
				await respond({
					text: "This channel is not allowed.",
					response_type: "ephemeral"
				});
				return;
			}
			const { allowFromLower: effectiveAllowFromLower } = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: isDirectMessage });
			let commandAuthorized = false;
			let channelConfig = null;
			if (isDirectMessage) {
				if (!await authorizeSlackDirectMessage({
					ctx,
					accountId: ctx.accountId,
					senderId: command.user_id,
					allowFromLower: effectiveAllowFromLower,
					resolveSenderName: ctx.resolveUserName,
					sendPairingReply: async (text) => {
						await respond({
							text,
							response_type: "ephemeral"
						});
					},
					onDisabled: async () => {
						await respond({
							text: "Slack DMs are disabled.",
							response_type: "ephemeral"
						});
					},
					onUnauthorized: async ({ allowMatchMeta }) => {
						logVerbose(`slack: blocked slash sender ${command.user_id} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`);
						await respond({
							text: "You are not authorized to use this command.",
							response_type: "ephemeral"
						});
					},
					log: logVerbose
				})) return;
			}
			if (isRoom) {
				channelConfig = resolveSlackChannelConfig({
					channelId: command.channel_id,
					channelName: channelInfo?.name,
					channels: ctx.channelsConfig,
					channelKeys: ctx.channelsConfigKeys,
					defaultRequireMention: ctx.defaultRequireMention,
					allowNameMatching: ctx.allowNameMatching
				});
				if (ctx.useAccessGroups) {
					const channelAllowlistConfigured = (ctx.channelsConfigKeys?.length ?? 0) > 0;
					const channelAllowed = channelConfig?.allowed !== false;
					if (!isSlackChannelAllowedByPolicy({
						groupPolicy: ctx.groupPolicy,
						channelAllowlistConfigured,
						channelAllowed
					})) {
						await respond({
							text: "This channel is not allowed.",
							response_type: "ephemeral"
						});
						return;
					}
					const hasExplicitConfig = Boolean(channelConfig?.matchSource);
					if (!channelAllowed && (ctx.groupPolicy !== "open" || hasExplicitConfig)) {
						await respond({
							text: "This channel is not allowed.",
							response_type: "ephemeral"
						});
						return;
					}
				}
			}
			const senderName = (await ctx.resolveUserName(command.user_id))?.name ?? command.user_name ?? command.user_id;
			const channelUsersAllowlistConfigured = isRoom && Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
			const channelUserAllowed = channelUsersAllowlistConfigured ? resolveSlackUserAllowed({
				allowList: channelConfig?.users,
				userId: command.user_id,
				userName: senderName,
				allowNameMatching: ctx.allowNameMatching
			}) : false;
			if (channelUsersAllowlistConfigured && !channelUserAllowed) {
				await respond({
					text: "You are not authorized to use this command here.",
					response_type: "ephemeral"
				});
				return;
			}
			const ownerAllowed = resolveSlackAllowListMatch({
				allowList: effectiveAllowFromLower,
				id: command.user_id,
				name: senderName,
				allowNameMatching: ctx.allowNameMatching
			}).allowed;
			commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
				useAccessGroups: ctx.useAccessGroups,
				authorizers: [{
					configured: effectiveAllowFromLower.length > 0,
					allowed: ownerAllowed
				}],
				modeWhenAccessGroupsOff: "configured"
			});
			if (isRoomish) {
				commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
					useAccessGroups: ctx.useAccessGroups,
					authorizers: [{
						configured: effectiveAllowFromLower.length > 0,
						allowed: ownerAllowed
					}, {
						configured: channelUsersAllowlistConfigured,
						allowed: channelUserAllowed
					}],
					modeWhenAccessGroupsOff: "configured"
				});
				if (ctx.useAccessGroups && !commandAuthorized) {
					await respond({
						text: "You are not authorized to use this command.",
						response_type: "ephemeral"
					});
					return;
				}
			}
			if (commandDefinition && supportsInteractiveArgMenus) {
				const { resolveCommandArgMenu } = await loadSlashCommandsRuntime();
				const menu = resolveCommandArgMenu({
					command: commandDefinition,
					args: commandArgs,
					cfg
				});
				if (menu) {
					const commandLabel = commandDefinition.nativeName ?? commandDefinition.key;
					const title = menu.title ?? `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`;
					await respond({
						text: title,
						blocks: buildSlackCommandArgMenuBlocks({
							title,
							command: commandLabel,
							arg: menu.arg.name,
							choices: menu.choices,
							userId: command.user_id,
							supportsExternalSelect: supportsExternalArgMenus,
							createExternalMenuToken: (choices) => storeSlackExternalArgMenu({
								choices,
								userId: command.user_id
							})
						}),
						response_type: "ephemeral"
					});
					return;
				}
			}
			const channelName = channelInfo?.name;
			const roomLabel = channelName ? `#${channelName}` : `#${command.channel_id}`;
			const { createReplyPrefixOptions, deliverSlackSlashReplies, dispatchReplyWithDispatcher, finalizeInboundContext, recordInboundSessionMetaSafe, resolveAgentRoute, resolveChunkMode, resolveConversationLabel, resolveMarkdownTableMode } = await loadSlashDispatchRuntime();
			const route = resolveAgentRoute({
				cfg,
				channel: "slack",
				accountId: account.accountId,
				teamId: ctx.teamId || void 0,
				peer: {
					kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
					id: isDirectMessage ? command.user_id : command.channel_id
				}
			});
			const { untrustedChannelMetadata, groupSystemPrompt } = resolveSlackRoomContextHints({
				isRoomish,
				channelInfo,
				channelConfig
			});
			const { sessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
				agentId: route.agentId,
				sessionPrefix: slashCommand.sessionPrefix,
				userId: command.user_id,
				targetSessionKey: route.sessionKey,
				lowercaseSessionKey: true
			});
			const ctxPayload = finalizeInboundContext({
				Body: prompt,
				BodyForAgent: prompt,
				RawBody: prompt,
				CommandBody: prompt,
				CommandArgs: commandArgs,
				From: isDirectMessage ? `slack:${command.user_id}` : isRoom ? `slack:channel:${command.channel_id}` : `slack:group:${command.channel_id}`,
				To: `slash:${command.user_id}`,
				ChatType: isDirectMessage ? "direct" : "channel",
				ConversationLabel: resolveConversationLabel({
					ChatType: isDirectMessage ? "direct" : "channel",
					SenderName: senderName,
					GroupSubject: isRoomish ? roomLabel : void 0,
					From: isDirectMessage ? `slack:${command.user_id}` : isRoom ? `slack:channel:${command.channel_id}` : `slack:group:${command.channel_id}`
				}) ?? (isDirectMessage ? senderName : roomLabel),
				GroupSubject: isRoomish ? roomLabel : void 0,
				GroupSystemPrompt: isRoomish ? groupSystemPrompt : void 0,
				UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : void 0,
				SenderName: senderName,
				SenderId: command.user_id,
				Provider: "slack",
				Surface: "slack",
				WasMentioned: true,
				MessageSid: command.trigger_id,
				Timestamp: Date.now(),
				SessionKey: sessionKey,
				CommandTargetSessionKey: commandTargetSessionKey,
				AccountId: route.accountId,
				CommandSource: "native",
				CommandAuthorized: commandAuthorized,
				OriginatingChannel: "slack",
				OriginatingTo: `user:${command.user_id}`
			});
			await recordInboundSessionMetaSafe({
				cfg,
				agentId: route.agentId,
				sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
				ctx: ctxPayload,
				onError: (err) => runtime.error?.(danger(`slack slash: failed updating session meta: ${String(err)}`))
			});
			const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
				cfg,
				agentId: route.agentId,
				channel: "slack",
				accountId: route.accountId
			});
			const deliverSlashPayloads = async (replies) => {
				await deliverSlackSlashReplies({
					replies,
					respond,
					ephemeral: slashCommand.ephemeral,
					textLimit: ctx.textLimit,
					chunkMode: resolveChunkMode(cfg, "slack", route.accountId),
					tableMode: resolveMarkdownTableMode({
						cfg,
						channel: "slack",
						accountId: route.accountId
					})
				});
			};
			const { counts } = await dispatchReplyWithDispatcher({
				ctx: ctxPayload,
				cfg,
				dispatcherOptions: {
					...prefixOptions,
					deliver: async (payload) => deliverSlashPayloads([payload]),
					onError: (err, info) => {
						runtime.error?.(danger(`slack slash ${info.kind} reply failed: ${String(err)}`));
					}
				},
				replyOptions: {
					skillFilter: channelConfig?.skills,
					onModelSelected
				}
			});
			if (counts.final + counts.tool + counts.block === 0) await deliverSlashPayloads([]);
		} catch (err) {
			runtime.error?.(danger(`slack slash handler failed: ${String(err)}`));
			await respond({
				text: "Sorry, something went wrong handling that command.",
				response_type: "ephemeral"
			});
		}
	};
	const nativeEnabled = resolveNativeCommandsEnabled({
		providerId: "slack",
		providerSetting: account.config.commands?.native,
		globalSetting: cfg.commands?.native
	});
	const nativeSkillsEnabled = resolveNativeSkillsEnabled({
		providerId: "slack",
		providerSetting: account.config.commands?.nativeSkills,
		globalSetting: cfg.commands?.nativeSkills
	});
	let nativeCommands = [];
	let slashCommandsRuntime = null;
	if (nativeEnabled) {
		slashCommandsRuntime = await loadSlashCommandsRuntime();
		const skillCommands = nativeSkillsEnabled ? (await loadSlashSkillCommandsRuntime()).listSkillCommandsForAgents({ cfg }) : [];
		nativeCommands = slashCommandsRuntime.listNativeCommandSpecsForConfig(cfg, {
			skillCommands,
			provider: "slack"
		});
	}
	if (nativeCommands.length > 0) {
		if (!slashCommandsRuntime) throw new Error("Missing commands runtime for native Slack commands.");
		for (const command of nativeCommands) ctx.app.command(`/${command.name}`, async ({ command: cmd, ack, respond, body }) => {
			const commandDefinition = slashCommandsRuntime.findCommandByNativeName(command.name, "slack");
			const rawText = cmd.text?.trim() ?? "";
			const commandArgs = commandDefinition ? slashCommandsRuntime.parseCommandArgs(commandDefinition, rawText) : rawText ? { raw: rawText } : void 0;
			await handleSlashCommand({
				command: cmd,
				ack,
				respond,
				body,
				prompt: commandDefinition ? slashCommandsRuntime.buildCommandTextFromArgs(commandDefinition, commandArgs) : rawText ? `/${command.name} ${rawText}` : `/${command.name}`,
				commandArgs,
				commandDefinition: commandDefinition ?? void 0
			});
		});
	} else if (slashCommand.enabled) ctx.app.command(buildSlackSlashCommandMatcher(slashCommand.name), async ({ command, ack, respond, body }) => {
		await handleSlashCommand({
			command,
			ack,
			respond,
			body,
			prompt: command.text?.trim() ?? ""
		});
	});
	else logVerbose("slack: slash commands disabled");
	if (nativeCommands.length === 0 || !supportsInteractiveArgMenus) return;
	const registerArgOptions = () => {
		const appWithOptions = ctx.app;
		if (typeof appWithOptions.options !== "function") return;
		appWithOptions.options(SLACK_COMMAND_ARG_ACTION_ID, async ({ ack, body }) => {
			if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
				await ack({ options: [] });
				runtime.log?.("slack: drop slash arg options payload (mismatched app/team)");
				return;
			}
			const typedBody = body;
			const token = readSlackExternalArgMenuToken(typedBody.actions?.[0]?.block_id ?? typedBody.block_id);
			if (!token) {
				await ack({ options: [] });
				return;
			}
			const entry = slackExternalArgMenuStore.get(token);
			if (!entry) {
				await ack({ options: [] });
				return;
			}
			const requesterUserId = typedBody.user?.id?.trim();
			if (!requesterUserId || requesterUserId !== entry.userId) {
				await ack({ options: [] });
				return;
			}
			const query = typedBody.value?.trim().toLowerCase() ?? "";
			await ack({ options: entry.choices.filter((choice) => !query || choice.label.toLowerCase().includes(query)).slice(0, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX).map((choice) => ({
				text: {
					type: "plain_text",
					text: choice.label.slice(0, 75)
				},
				value: choice.value
			})) });
		});
	};
	try {
		registerArgOptions();
	} catch (err) {
		supportsExternalArgMenus = false;
		logVerbose(`slack: external arg-menu registration failed, falling back to static menus: ${String(err)}`);
	}
	const registerArgAction = (actionId) => {
		ctx.app.action(actionId, async (args) => {
			const { ack, body, respond } = args;
			const action = args.action;
			await ack();
			if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
				runtime.log?.("slack: drop slash arg action payload (mismatched app/team)");
				return;
			}
			const respondFn = respond ?? (async (payload) => {
				if (!body.channel?.id || !body.user?.id) return;
				await ctx.app.client.chat.postEphemeral({
					token: ctx.botToken,
					channel: body.channel.id,
					user: body.user.id,
					text: payload.text,
					blocks: payload.blocks
				});
			});
			const parsed = parseSlackCommandArgValue(action?.value ?? action?.selected_option?.value);
			if (!parsed) {
				await respondFn({
					text: "Sorry, that button is no longer valid.",
					response_type: "ephemeral"
				});
				return;
			}
			if (body.user?.id && parsed.userId !== body.user.id) {
				await respondFn({
					text: "That menu is for another user.",
					response_type: "ephemeral"
				});
				return;
			}
			const { buildCommandTextFromArgs, findCommandByNativeName } = await loadSlashCommandsRuntime();
			const commandDefinition = findCommandByNativeName(parsed.command, "slack");
			const commandArgs = { values: { [parsed.arg]: parsed.value } };
			const prompt = commandDefinition ? buildCommandTextFromArgs(commandDefinition, commandArgs) : `/${parsed.command} ${parsed.value}`;
			const user = body.user;
			const userName = user && "name" in user && user.name ? user.name : user && "username" in user && user.username ? user.username : user?.id ?? "";
			const triggerId = "trigger_id" in body ? body.trigger_id : void 0;
			await handleSlashCommand({
				command: {
					user_id: user?.id ?? "",
					user_name: userName,
					channel_id: body.channel?.id ?? "",
					channel_name: body.channel?.name ?? body.channel?.id ?? "",
					trigger_id: triggerId
				},
				ack: async () => {},
				respond: respondFn,
				body,
				prompt,
				commandArgs,
				commandDefinition: commandDefinition ?? void 0
			});
		});
	};
	registerArgAction(SLACK_COMMAND_ARG_ACTION_ID);
}
//#endregion
//#region extensions/slack/src/monitor/provider.ts
init_globals();
init_session_key();
function isConstructorFunction(value) {
	return typeof value === "function";
}
function resolveSlackBoltModule(value) {
	if (!value || typeof value !== "object") return null;
	const app = Reflect.get(value, "App");
	const httpReceiver = Reflect.get(value, "HTTPReceiver");
	if (!isConstructorFunction(app) || !isConstructorFunction(httpReceiver)) return null;
	return {
		App: app,
		HTTPReceiver: httpReceiver
	};
}
function resolveSlackBoltInterop(params) {
	const { defaultImport, namespaceImport } = params;
	const nestedDefault = defaultImport && typeof defaultImport === "object" ? Reflect.get(defaultImport, "default") : void 0;
	const namespaceDefault = namespaceImport && typeof namespaceImport === "object" ? Reflect.get(namespaceImport, "default") : void 0;
	const namespaceReceiver = namespaceImport && typeof namespaceImport === "object" ? Reflect.get(namespaceImport, "HTTPReceiver") : void 0;
	const directModule = resolveSlackBoltModule(defaultImport) ?? resolveSlackBoltModule(nestedDefault) ?? resolveSlackBoltModule(namespaceDefault) ?? resolveSlackBoltModule(namespaceImport);
	if (directModule) return directModule;
	if (isConstructorFunction(defaultImport) && isConstructorFunction(namespaceReceiver)) return {
		App: defaultImport,
		HTTPReceiver: namespaceReceiver
	};
	throw new TypeError("Unable to resolve @slack/bolt App/HTTPReceiver exports");
}
const { App, HTTPReceiver } = resolveSlackBoltInterop({
	defaultImport: SlackBolt,
	namespaceImport: SlackBoltNamespace
});
const SLACK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const SLACK_WEBHOOK_BODY_TIMEOUT_MS = 3e4;
function parseApiAppIdFromAppToken(raw) {
	const token = raw?.trim();
	if (!token) return;
	return /^xapp-\d-([a-z0-9]+)-/i.exec(token)?.[1]?.toUpperCase();
}
function publishSlackConnectedStatus(setStatus) {
	if (!setStatus) return;
	setStatus({
		...createConnectedChannelStatusPatch(Date.now()),
		lastError: null
	});
}
function publishSlackDisconnectedStatus(setStatus, error) {
	if (!setStatus) return;
	const at = Date.now();
	const message = error ? formatUnknownError(error) : void 0;
	setStatus({
		connected: false,
		lastDisconnect: message ? {
			at,
			error: message
		} : { at },
		lastError: message ?? null
	});
}
async function monitorSlackProvider(opts = {}) {
	const cfg = opts.config ?? loadConfig();
	const runtime = opts.runtime ?? createNonExitingRuntime();
	let account = resolveSlackAccount({
		cfg,
		accountId: opts.accountId
	});
	if (!account.enabled) {
		runtime.log?.(`[${account.accountId}] slack account disabled; monitor startup skipped`);
		if (opts.abortSignal?.aborted) return;
		await new Promise((resolve) => {
			opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return;
	}
	const historyLimit = Math.max(0, account.config.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 50);
	const sessionCfg = cfg.session;
	const sessionScope = sessionCfg?.scope ?? "per-sender";
	const mainKey = normalizeMainKey(sessionCfg?.mainKey);
	const slackMode = opts.mode ?? account.config.mode ?? "socket";
	const slackWebhookPath = normalizeSlackWebhookPath(account.config.webhookPath);
	const signingSecret = normalizeResolvedSecretInputString({
		value: account.config.signingSecret,
		path: `channels.slack.accounts.${account.accountId}.signingSecret`
	});
	const botToken = resolveSlackBotToken(opts.botToken ?? account.botToken);
	const appToken = resolveSlackAppToken(opts.appToken ?? account.appToken);
	if (!botToken || slackMode !== "http" && !appToken) {
		const missing = slackMode === "http" ? `Slack bot token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken or SLACK_BOT_TOKEN for default).` : `Slack bot + app tokens missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken/appToken or SLACK_BOT_TOKEN/SLACK_APP_TOKEN for default).`;
		throw new Error(missing);
	}
	if (slackMode === "http" && !signingSecret) throw new Error(`Slack signing secret missing for account "${account.accountId}" (set channels.slack.signingSecret or channels.slack.accounts.${account.accountId}.signingSecret).`);
	const slackCfg = account.config;
	const dmConfig = slackCfg.dm;
	const dmEnabled = dmConfig?.enabled ?? true;
	const dmPolicy = slackCfg.dmPolicy ?? dmConfig?.policy ?? "pairing";
	let allowFrom = slackCfg.allowFrom ?? dmConfig?.allowFrom;
	const groupDmEnabled = dmConfig?.groupEnabled ?? false;
	const groupDmChannels = dmConfig?.groupChannels;
	let channelsConfig = slackCfg.channels;
	const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
	const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: cfg.channels?.slack !== void 0,
		groupPolicy: slackCfg.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "slack",
		accountId: account.accountId,
		log: (message) => runtime.log?.(warn(message))
	});
	const resolveToken = account.userToken || botToken;
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const reactionMode = slackCfg.reactionNotifications ?? "own";
	const reactionAllowlist = slackCfg.reactionAllowlist ?? [];
	const replyToMode = slackCfg.replyToMode ?? "off";
	const threadHistoryScope = slackCfg.thread?.historyScope ?? "thread";
	const threadInheritParent = slackCfg.thread?.inheritParent ?? false;
	const slashCommand = resolveSlackSlashCommandConfig(opts.slashCommand ?? slackCfg.slashCommand);
	const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId);
	const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
	const typingReaction = slackCfg.typingReaction?.trim() ?? "";
	const mediaMaxBytes = (opts.mediaMaxMb ?? slackCfg.mediaMaxMb ?? 20) * 1024 * 1024;
	const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
	const receiver = slackMode === "http" ? new HTTPReceiver({
		signingSecret: signingSecret ?? "",
		endpoints: slackWebhookPath
	}) : null;
	const clientOptions = resolveSlackWebClientOptions();
	const app = new App(slackMode === "socket" ? {
		token: botToken,
		appToken,
		socketMode: true,
		clientOptions
	} : {
		token: botToken,
		receiver: receiver ?? void 0,
		clientOptions
	});
	const slackHttpHandler = slackMode === "http" && receiver ? async (req, res) => {
		const guard = installRequestBodyLimitGuard(req, res, {
			maxBytes: SLACK_WEBHOOK_MAX_BODY_BYTES,
			timeoutMs: SLACK_WEBHOOK_BODY_TIMEOUT_MS,
			responseFormat: "text"
		});
		if (guard.isTripped()) return;
		try {
			await Promise.resolve(receiver.requestListener(req, res));
		} catch (err) {
			if (!guard.isTripped()) throw err;
		} finally {
			guard.dispose();
		}
	} : null;
	let unregisterHttpHandler = null;
	let botUserId = "";
	let teamId = "";
	let apiAppId = "";
	const expectedApiAppIdFromAppToken = parseApiAppIdFromAppToken(appToken);
	try {
		const auth = await app.client.auth.test({ token: botToken });
		botUserId = auth.user_id ?? "";
		teamId = auth.team_id ?? "";
		apiAppId = auth.api_app_id ?? "";
	} catch {}
	if (apiAppId && expectedApiAppIdFromAppToken && apiAppId !== expectedApiAppIdFromAppToken) runtime.error?.(`slack token mismatch: bot token api_app_id=${apiAppId} but app token looks like api_app_id=${expectedApiAppIdFromAppToken}`);
	const ctx = createSlackMonitorContext({
		cfg,
		accountId: account.accountId,
		botToken,
		app,
		runtime,
		botUserId,
		teamId,
		apiAppId,
		historyLimit,
		sessionScope,
		mainKey,
		dmEnabled,
		dmPolicy,
		allowFrom,
		allowNameMatching: isDangerousNameMatchingEnabled(slackCfg),
		groupDmEnabled,
		groupDmChannels,
		defaultRequireMention: slackCfg.requireMention,
		channelsConfig,
		groupPolicy,
		useAccessGroups,
		reactionMode,
		reactionAllowlist,
		replyToMode,
		threadHistoryScope,
		threadInheritParent,
		slashCommand,
		textLimit,
		ackReactionScope,
		typingReaction,
		mediaMaxBytes,
		removeAckAfterReply
	});
	const trackEvent = opts.setStatus ? () => {
		opts.setStatus({
			lastEventAt: Date.now(),
			lastInboundAt: Date.now()
		});
	} : void 0;
	registerSlackMonitorEvents({
		ctx,
		account,
		handleSlackMessage: createSlackMessageHandler({
			ctx,
			account,
			trackEvent
		}),
		trackEvent
	});
	await registerSlackMonitorSlashCommands({
		ctx,
		account
	});
	if (slackMode === "http" && slackHttpHandler) unregisterHttpHandler = registerSlackHttpHandler({
		path: slackWebhookPath,
		handler: slackHttpHandler,
		log: runtime.log,
		accountId: account.accountId
	});
	if (resolveToken) (async () => {
		if (opts.abortSignal?.aborted) return;
		if (channelsConfig && Object.keys(channelsConfig).length > 0) try {
			const entries = Object.keys(channelsConfig).filter((key) => key !== "*");
			if (entries.length > 0) {
				const resolved = await resolveSlackChannelAllowlist({
					token: resolveToken,
					entries
				});
				const nextChannels = { ...channelsConfig };
				const mapping = [];
				const unresolved = [];
				for (const entry of resolved) {
					const source = channelsConfig?.[entry.input];
					if (!source) continue;
					if (!entry.resolved || !entry.id) {
						unresolved.push(entry.input);
						continue;
					}
					mapping.push(`${entry.input}→${entry.id}${entry.archived ? " (archived)" : ""}`);
					const existing = nextChannels[entry.id] ?? {};
					nextChannels[entry.id] = {
						...source,
						...existing
					};
				}
				channelsConfig = nextChannels;
				ctx.channelsConfig = nextChannels;
				summarizeMapping("slack channels", mapping, unresolved, runtime);
			}
		} catch (err) {
			runtime.log?.(`slack channel resolve failed; using config entries. ${String(err)}`);
		}
		const allowEntries = normalizeStringEntries(allowFrom).filter((entry) => entry !== "*");
		if (allowEntries.length > 0) try {
			const { mapping, unresolved, additions } = buildAllowlistResolutionSummary(await resolveSlackUserAllowlist({
				token: resolveToken,
				entries: allowEntries
			}), { formatResolved: (entry) => {
				const note = entry.note ? ` (${entry.note})` : "";
				return `${entry.input}→${entry.id}${note}`;
			} });
			allowFrom = mergeAllowlist({
				existing: allowFrom,
				additions
			});
			ctx.allowFrom = normalizeAllowList(allowFrom);
			summarizeMapping("slack users", mapping, unresolved, runtime);
		} catch (err) {
			runtime.log?.(`slack user resolve failed; using config entries. ${String(err)}`);
		}
		if (channelsConfig && Object.keys(channelsConfig).length > 0) {
			const userEntries = /* @__PURE__ */ new Set();
			for (const channel of Object.values(channelsConfig)) addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
			if (userEntries.size > 0) try {
				const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(await resolveSlackUserAllowlist({
					token: resolveToken,
					entries: Array.from(userEntries)
				}));
				const nextChannels = patchAllowlistUsersInConfigEntries({
					entries: channelsConfig,
					resolvedMap
				});
				channelsConfig = nextChannels;
				ctx.channelsConfig = nextChannels;
				summarizeMapping("slack channel users", mapping, unresolved, runtime);
			} catch (err) {
				runtime.log?.(`slack channel user resolve failed; using config entries. ${String(err)}`);
			}
		}
	})();
	const stopOnAbort = () => {
		if (opts.abortSignal?.aborted && slackMode === "socket") app.stop();
	};
	opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
	try {
		if (slackMode === "socket") {
			let reconnectAttempts = 0;
			while (!opts.abortSignal?.aborted) {
				try {
					await app.start();
					reconnectAttempts = 0;
					publishSlackConnectedStatus(opts.setStatus);
					runtime.log?.("slack socket mode connected");
				} catch (err) {
					if (isNonRecoverableSlackAuthError(err)) {
						runtime.error?.(`slack socket mode failed to start due to non-recoverable auth error — skipping channel (${formatUnknownError(err)})`);
						throw err;
					}
					reconnectAttempts += 1;
					if (SLACK_SOCKET_RECONNECT_POLICY.maxAttempts > 0 && reconnectAttempts >= SLACK_SOCKET_RECONNECT_POLICY.maxAttempts) throw err;
					const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
					runtime.error?.(`slack socket mode failed to start. retry ${reconnectAttempts}/${SLACK_SOCKET_RECONNECT_POLICY.maxAttempts || "∞"} in ${Math.round(delayMs / 1e3)}s (${formatUnknownError(err)})`);
					try {
						await sleepWithAbort(delayMs, opts.abortSignal);
					} catch {
						break;
					}
					continue;
				}
				if (opts.abortSignal?.aborted) break;
				const disconnect = await waitForSlackSocketDisconnect(app, opts.abortSignal);
				if (opts.abortSignal?.aborted) break;
				publishSlackDisconnectedStatus(opts.setStatus, disconnect.error);
				if (disconnect.error && isNonRecoverableSlackAuthError(disconnect.error)) {
					runtime.error?.(`slack socket mode disconnected due to non-recoverable auth error — skipping channel (${formatUnknownError(disconnect.error)})`);
					throw disconnect.error instanceof Error ? disconnect.error : new Error(formatUnknownError(disconnect.error));
				}
				reconnectAttempts += 1;
				if (SLACK_SOCKET_RECONNECT_POLICY.maxAttempts > 0 && reconnectAttempts >= SLACK_SOCKET_RECONNECT_POLICY.maxAttempts) throw new Error(`Slack socket mode reconnect max attempts reached (${reconnectAttempts}/${SLACK_SOCKET_RECONNECT_POLICY.maxAttempts}) after ${disconnect.event}`);
				const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
				runtime.error?.(`slack socket disconnected (${disconnect.event}). retry ${reconnectAttempts}/${SLACK_SOCKET_RECONNECT_POLICY.maxAttempts || "∞"} in ${Math.round(delayMs / 1e3)}s${disconnect.error ? ` (${formatUnknownError(disconnect.error)})` : ""}`);
				await app.stop().catch(() => void 0);
				try {
					await sleepWithAbort(delayMs, opts.abortSignal);
				} catch {
					break;
				}
			}
		} else {
			runtime.log?.(`slack http mode listening at ${slackWebhookPath}`);
			if (!opts.abortSignal?.aborted) await new Promise((resolve) => {
				opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
			});
		}
	} finally {
		opts.abortSignal?.removeEventListener("abort", stopOnAbort);
		unregisterHttpHandler?.();
		await app.stop().catch(() => void 0);
	}
}
//#endregion
//#region extensions/slack/src/probe.ts
async function probeSlack(token, timeoutMs = 2500) {
	const client = createSlackWebClient(token);
	const start = Date.now();
	try {
		const result = await withTimeout(client.auth.test(), timeoutMs);
		if (!result.ok) return {
			ok: false,
			status: 200,
			error: result.error ?? "unknown",
			elapsedMs: Date.now() - start
		};
		return {
			ok: true,
			status: 200,
			elapsedMs: Date.now() - start,
			bot: {
				id: result.user_id,
				name: result.user
			},
			team: {
				id: result.team_id,
				name: result.team
			}
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			status: typeof err.status === "number" ? err.status : null,
			error: message,
			elapsedMs: Date.now() - start
		};
	}
}
//#endregion
//#region src/agents/tools/slack-actions.ts
const messagingActions = new Set([
	"sendMessage",
	"editMessage",
	"deleteMessage",
	"readMessages",
	"downloadFile"
]);
const reactionsActions = new Set(["react", "reactions"]);
const pinActions = new Set([
	"pinMessage",
	"unpinMessage",
	"listPins"
]);
/**
* Resolve threadTs for a Slack message based on context and replyToMode.
* - "all": always inject threadTs
* - "first": inject only for first message (updates hasRepliedRef)
* - "off": never auto-inject
*/
function resolveThreadTsFromContext(explicitThreadTs, targetChannel, context) {
	if (explicitThreadTs) return explicitThreadTs;
	if (!context?.currentThreadTs || !context?.currentChannelId) return;
	const parsedTarget = parseSlackTarget(targetChannel, { defaultKind: "channel" });
	if (!parsedTarget || parsedTarget.kind !== "channel") return;
	if (parsedTarget.id !== context.currentChannelId) return;
	if (context.replyToMode === "all") return context.currentThreadTs;
	if (context.replyToMode === "first" && context.hasRepliedRef && !context.hasRepliedRef.value) {
		context.hasRepliedRef.value = true;
		return context.currentThreadTs;
	}
}
function readSlackBlocksParam(params) {
	return parseSlackBlocksInput(params.blocks);
}
async function handleSlackAction(params, cfg, context) {
	const resolveChannelId = () => resolveSlackChannelId(readStringParam(params, "channelId", { required: true }));
	const action = readStringParam(params, "action", { required: true });
	const accountId = readStringParam(params, "accountId");
	const account = resolveSlackAccount({
		cfg,
		accountId
	});
	const isActionEnabled = createActionGate(account.actions ?? cfg.channels?.slack?.actions);
	const userToken = account.userToken;
	const botToken = account.botToken?.trim();
	const allowUserWrites = account.config.userTokenReadOnly === false;
	const getTokenForOperation = (operation) => {
		if (operation === "read") return userToken ?? botToken;
		if (!allowUserWrites) return botToken;
		return botToken ?? userToken;
	};
	const buildActionOpts = (operation) => {
		const token = getTokenForOperation(operation);
		const tokenOverride = token && token !== botToken ? token : void 0;
		if (!accountId && !tokenOverride) return;
		return {
			...accountId ? { accountId } : {},
			...tokenOverride ? { token: tokenOverride } : {}
		};
	};
	const readOpts = buildActionOpts("read");
	const writeOpts = buildActionOpts("write");
	if (reactionsActions.has(action)) {
		if (!isActionEnabled("reactions")) throw new Error("Slack reactions are disabled.");
		const channelId = resolveChannelId();
		const messageId = readStringParam(params, "messageId", { required: true });
		if (action === "react") {
			const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove a Slack reaction." });
			if (remove) {
				if (writeOpts) await removeSlackReaction(channelId, messageId, emoji, writeOpts);
				else await removeSlackReaction(channelId, messageId, emoji);
				return jsonResult({
					ok: true,
					removed: emoji
				});
			}
			if (isEmpty) return jsonResult({
				ok: true,
				removed: writeOpts ? await removeOwnSlackReactions(channelId, messageId, writeOpts) : await removeOwnSlackReactions(channelId, messageId)
			});
			if (writeOpts) await reactSlackMessage(channelId, messageId, emoji, writeOpts);
			else await reactSlackMessage(channelId, messageId, emoji);
			return jsonResult({
				ok: true,
				added: emoji
			});
		}
		return jsonResult({
			ok: true,
			reactions: readOpts ? await listSlackReactions(channelId, messageId, readOpts) : await listSlackReactions(channelId, messageId)
		});
	}
	if (messagingActions.has(action)) {
		if (!isActionEnabled("messages")) throw new Error("Slack messages are disabled.");
		switch (action) {
			case "sendMessage": {
				const to = readStringParam(params, "to", { required: true });
				const content = readStringParam(params, "content", { allowEmpty: true });
				const mediaUrl = readStringParam(params, "mediaUrl");
				const blocks = readSlackBlocksParam(params);
				if (!content && !mediaUrl && !blocks) throw new Error("Slack sendMessage requires content, blocks, or mediaUrl.");
				if (mediaUrl && blocks) throw new Error("Slack sendMessage does not support blocks with mediaUrl.");
				const threadTs = resolveThreadTsFromContext(readStringParam(params, "threadTs"), to, context);
				const result = await sendSlackMessage(to, content ?? "", {
					...writeOpts,
					mediaUrl: mediaUrl ?? void 0,
					mediaLocalRoots: context?.mediaLocalRoots,
					threadTs: threadTs ?? void 0,
					blocks
				});
				if (threadTs && result.channelId && account.accountId) recordSlackThreadParticipation(account.accountId, result.channelId, threadTs);
				if (context?.hasRepliedRef && context.currentChannelId) {
					const parsedTarget = parseSlackTarget(to, { defaultKind: "channel" });
					if (parsedTarget?.kind === "channel" && parsedTarget.id === context.currentChannelId) context.hasRepliedRef.value = true;
				}
				return jsonResult({
					ok: true,
					result
				});
			}
			case "editMessage": {
				const channelId = resolveChannelId();
				const messageId = readStringParam(params, "messageId", { required: true });
				const content = readStringParam(params, "content", { allowEmpty: true });
				const blocks = readSlackBlocksParam(params);
				if (!content && !blocks) throw new Error("Slack editMessage requires content or blocks.");
				if (writeOpts) await editSlackMessage(channelId, messageId, content ?? "", {
					...writeOpts,
					blocks
				});
				else await editSlackMessage(channelId, messageId, content ?? "", { blocks });
				return jsonResult({ ok: true });
			}
			case "deleteMessage": {
				const channelId = resolveChannelId();
				const messageId = readStringParam(params, "messageId", { required: true });
				if (writeOpts) await deleteSlackMessage(channelId, messageId, writeOpts);
				else await deleteSlackMessage(channelId, messageId);
				return jsonResult({ ok: true });
			}
			case "readMessages": {
				const channelId = resolveChannelId();
				const limitRaw = params.limit;
				const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : void 0;
				const before = readStringParam(params, "before");
				const after = readStringParam(params, "after");
				const threadId = readStringParam(params, "threadId");
				const result = await readSlackMessages(channelId, {
					...readOpts,
					limit,
					before: before ?? void 0,
					after: after ?? void 0,
					threadId: threadId ?? void 0
				});
				return jsonResult({
					ok: true,
					messages: result.messages.map((message) => withNormalizedTimestamp(message, message.ts)),
					hasMore: result.hasMore
				});
			}
			case "downloadFile": {
				const fileId = readStringParam(params, "fileId", { required: true });
				const channelTarget = readStringParam(params, "channelId") ?? readStringParam(params, "to");
				const channelId = channelTarget ? resolveSlackChannelId(channelTarget) : void 0;
				const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
				const maxBytes = account.config?.mediaMaxMb ? account.config.mediaMaxMb * 1024 * 1024 : 20 * 1024 * 1024;
				const downloaded = await downloadSlackFile(fileId, {
					...readOpts,
					maxBytes,
					channelId,
					threadId: threadId ?? void 0
				});
				if (!downloaded) return jsonResult({
					ok: false,
					error: "File could not be downloaded (not found, too large, or inaccessible)."
				});
				return await imageResultFromFile({
					label: "slack-file",
					path: downloaded.path,
					extraText: downloaded.placeholder,
					details: {
						fileId,
						path: downloaded.path
					}
				});
			}
			default: break;
		}
	}
	if (pinActions.has(action)) {
		if (!isActionEnabled("pins")) throw new Error("Slack pins are disabled.");
		const channelId = resolveChannelId();
		if (action === "pinMessage") {
			const messageId = readStringParam(params, "messageId", { required: true });
			if (writeOpts) await pinSlackMessage(channelId, messageId, writeOpts);
			else await pinSlackMessage(channelId, messageId);
			return jsonResult({ ok: true });
		}
		if (action === "unpinMessage") {
			const messageId = readStringParam(params, "messageId", { required: true });
			if (writeOpts) await unpinSlackMessage(channelId, messageId, writeOpts);
			else await unpinSlackMessage(channelId, messageId);
			return jsonResult({ ok: true });
		}
		return jsonResult({
			ok: true,
			pins: (writeOpts ? await listSlackPins(channelId, readOpts) : await listSlackPins(channelId)).map((pin) => {
				const message = pin.message ? withNormalizedTimestamp(pin.message, pin.message.ts) : pin.message;
				return message ? {
					...pin,
					message
				} : pin;
			})
		});
	}
	if (action === "memberInfo") {
		if (!isActionEnabled("memberInfo")) throw new Error("Slack member info is disabled.");
		const userId = readStringParam(params, "userId", { required: true });
		return jsonResult({
			ok: true,
			info: writeOpts ? await getSlackMemberInfo(userId, readOpts) : await getSlackMemberInfo(userId)
		});
	}
	if (action === "emojiList") {
		if (!isActionEnabled("emojiList")) throw new Error("Slack emoji list is disabled.");
		const result = readOpts ? await listSlackEmojis(readOpts) : await listSlackEmojis();
		const limit = readNumberParam(params, "limit", { integer: true });
		if (limit != null && limit > 0 && result.emoji != null) {
			const entries = Object.entries(result.emoji).toSorted(([a], [b]) => a.localeCompare(b));
			if (entries.length > limit) return jsonResult({
				ok: true,
				emojis: {
					...result,
					emoji: Object.fromEntries(entries.slice(0, limit))
				}
			});
		}
		return jsonResult({
			ok: true,
			emojis: result
		});
	}
	throw new Error(`Unknown action: ${action}`);
}
//#endregion
export { handleSlackAction, listSlackDirectoryGroupsLive, listSlackDirectoryPeersLive, monitorSlackProvider, probeSlack, resolveSlackChannelAllowlist, resolveSlackUserAllowlist, sendMessageSlack };
