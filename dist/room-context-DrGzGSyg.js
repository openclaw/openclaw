import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { f as resolveThreadSessionKeys } from "./session-key-DFEyR49L.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-26EcJVc0.js";
import { i as getChildLogger } from "./logger-DIiFDaHc.js";
import { r as logVerbose } from "./globals-CouSpJO4.js";
import { t as createDedupeCache } from "./dedupe-Cby1DfpJ.js";
import { a as resolveChannelEntryMatchWithFallback, n as buildChannelKeyCandidates, t as applyChannelMatchMeta } from "./channel-config-BNiVnyY6.js";
import { n as formatAllowlistMatchMeta } from "./allowlist-match-D1SSm7UQ.js";
import { n as resolveSessionKey } from "./session-key-CDZmhV4O.js";
import { i as resolveAgentRoute } from "./resolve-route-DQZZzDyD.js";
import "./error-runtime-BnVeBNYa.js";
import "./runtime-env-AKjXcC53.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./routing-BfSZVtOk.js";
import { d as upsertChannelPairingRequest } from "./pairing-store-DKcswb9w.js";
import { c as defineStableChannelIngressIdentity, n as createChannelIngressResolver, r as readChannelIngressStoreAllowFromForDmPolicy } from "./runtime-DIN0JAgX.js";
import "./runtime-config-snapshot-pRc6W_Li.js";
import { r as resolveRuntimeConversationBindingRoute } from "./binding-routing-LTxSqa_y.js";
import "./conversation-runtime-BzsYFdpF.js";
import "./agent-runtime-C0lBBqMR.js";
import { r as buildUntrustedChannelMetadata } from "./security-runtime-JcBeOGgV.js";
import "./channel-ingress-runtime-C2vv_xqD.js";
import { t as createChannelPairingChallengeIssuer } from "./channel-pairing--8umY0wm.js";
import "./channel-targets-DqRLwtU8.js";
import "./session-store-runtime-DIobQazh.js";
import { a as normalizeSlackSlug, i as normalizeSlackAllowOwnerEntry, n as normalizeAllowList, o as resolveSlackAllowListMatch, r as normalizeAllowListLower, t as allowListMatches } from "./allow-list-NJrZzx1V.js";
import { t as formatSlackError } from "./errors-C7qatgFo.js";
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
	const name = normalizeSlackSlashCommandName(normalizeOptionalString(raw?.name) ?? "openclaw") || "openclaw";
	return {
		enabled: raw?.enabled === true,
		name,
		sessionPrefix: normalizeOptionalString(raw?.sessionPrefix) ?? "slack:slash",
		ephemeral: raw?.ephemeral !== false
	};
}
function buildSlackSlashCommandMatcher(name) {
	const escaped = normalizeSlackSlashCommandName(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^/?${escaped}$`);
}
//#endregion
//#region extensions/slack/src/monitor/channel-config.ts
function firstDefined(...values) {
	for (const value of values) if (value !== void 0) return value;
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
	const channelIdLower = normalizeLowercaseStringOrEmpty(channelId);
	const channelIdUpper = channelId.toUpperCase();
	const channelTarget = `channel:${channelId}`;
	const channelTargetLower = `channel:${channelIdLower}`;
	const channelTargetUpper = `channel:${channelIdUpper}`;
	const match = resolveChannelEntryMatchWithFallback({
		entries,
		keys: buildChannelKeyCandidates(channelId, channelIdLower !== channelId ? channelIdLower : void 0, channelIdUpper !== channelId ? channelIdUpper : void 0, channelTarget, channelTargetLower !== channelTarget ? channelTargetLower : void 0, channelTargetUpper !== channelTarget ? channelTargetUpper : void 0, allowNameMatching ? channelName ? `#${directName}` : void 0 : void 0, allowNameMatching ? directName : void 0, allowNameMatching ? normalizedName : void 0),
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
		allowed: firstDefined(resolved.enabled, fallback?.enabled, true) ?? true,
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
	const normalized = normalizeOptionalLowercaseString(channelType);
	const inferred = inferSlackChannelType(channelId);
	if (normalized === "im" || normalized === "mpim" || normalized === "channel" || normalized === "group") {
		if (inferred === "im" && normalized !== "im") return "im";
		return normalized;
	}
	return inferred ?? "channel";
}
function resolveSlackChatType(channelType) {
	if (channelType === "im") return "direct";
	if (channelType === "mpim") return "group";
	return "channel";
}
//#endregion
//#region extensions/slack/src/monitor/policy.ts
function isSlackChannelAllowedByPolicy(params) {
	if (params.groupPolicy === "disabled") return false;
	return params.groupPolicy !== "allowlist" || params.channelAllowlistConfigured && params.channelAllowed;
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
	const releaseSeenMessage = (channelId, ts) => {
		if (!channelId || !ts) return;
		seenMessages.delete(`${channelId}:${ts}`);
	};
	const resolveSlackSystemEventSessionKey = (p) => {
		const channelId = normalizeOptionalString(p.channelId) ?? "";
		if (!channelId) return params.mainKey;
		const channelType = normalizeSlackChannelType(p.channelType, channelId);
		const isDirectMessage = channelType === "im";
		const isGroup = channelType === "mpim";
		const from = isDirectMessage ? `slack:${channelId}` : isGroup ? `slack:group:${channelId}` : `slack:channel:${channelId}`;
		const chatType = isDirectMessage ? "direct" : isGroup ? "group" : "channel";
		const senderId = normalizeOptionalString(p.senderId) ?? "";
		try {
			const peerKind = isDirectMessage ? "direct" : isGroup ? "group" : "channel";
			const peerId = isDirectMessage ? senderId : channelId;
			if (peerId) {
				const route = resolveAgentRoute({
					cfg: params.cfg,
					channel: "slack",
					accountId: params.accountId,
					teamId: params.teamId,
					peer: {
						kind: peerKind,
						id: peerId
					}
				});
				const threadTs = normalizeOptionalString(p.threadTs);
				const baseConversationId = isDirectMessage ? `user:${senderId}` : channelId;
				const threadBindingRoute = threadTs ? resolveRuntimeConversationBindingRoute({
					route,
					conversation: {
						channel: "slack",
						accountId: params.accountId,
						conversationId: threadTs,
						parentConversationId: baseConversationId
					}
				}) : null;
				const runtimeRoute = threadBindingRoute?.boundSessionKey || threadBindingRoute?.bindingRecord ? threadBindingRoute : resolveRuntimeConversationBindingRoute({
					route,
					conversation: {
						channel: "slack",
						accountId: params.accountId,
						conversationId: baseConversationId
					}
				});
				if (runtimeRoute.boundSessionKey) return runtimeRoute.route.sessionKey;
				return resolveThreadSessionKeys({
					baseSessionKey: runtimeRoute.route.sessionKey,
					threadId: threadTs,
					parentSessionKey: threadTs && params.threadInheritParent ? runtimeRoute.route.sessionKey : void 0
				}).sessionKey;
			}
		} catch {}
		const legacySessionKey = resolveSessionKey(params.sessionScope, {
			From: from,
			ChatType: chatType,
			Provider: "slack"
		}, params.mainKey, resolveDefaultAgentId(params.cfg));
		return resolveThreadSessionKeys({
			baseSessionKey: legacySessionKey,
			threadId: normalizeOptionalString(p.threadTs),
			parentSessionKey: normalizeOptionalString(p.threadTs) && params.threadInheritParent ? legacySessionKey : void 0
		}).sessionKey;
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
		try {
			await params.app.client.assistant.threads.setStatus({
				token: params.botToken,
				channel_id: p.channelId,
				thread_ts: p.threadTs,
				status: p.status
			});
		} catch (err) {
			logVerbose(`slack status update failed for channel ${p.channelId}: ${formatSlackError(err)}`);
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
			].filter((value) => Boolean(value)).map((value) => normalizeLowercaseStringOrEmpty(value));
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
		botId: params.botId,
		teamId: params.teamId,
		apiAppId: params.apiAppId,
		historyLimit: params.historyLimit,
		dmHistoryLimit: Math.max(0, params.dmHistoryLimit ?? 0),
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
		threadRequireExplicitMention: params.threadRequireExplicitMention,
		slashCommand: params.slashCommand,
		textLimit: params.textLimit,
		ackReactionScope: params.ackReactionScope,
		typingReaction: params.typingReaction,
		mediaMaxBytes: params.mediaMaxBytes,
		removeAckAfterReply: params.removeAckAfterReply,
		logger,
		markMessageSeen,
		releaseSeenMessage,
		shouldDropMismatchedSlackEvent,
		resolveSlackSystemEventSessionKey,
		isChannelAllowed,
		resolveChannelName,
		resolveUserName,
		setSlackThreadStatus
	};
}
//#endregion
//#region extensions/slack/src/monitor/auth.ts
let slackChannelMembersCache = /* @__PURE__ */ new WeakMap();
const DEFAULT_CHANNEL_MEMBERS_CACHE_TTL_MS = 6e4;
const CHANNEL_MEMBERS_CACHE_MAX = 512;
const SLACK_CHANNEL_ID = "slack";
const SLACK_USER_NAME_KIND = "plugin:slack-user-name";
function normalizeSlackUserId(raw) {
	const value = (raw ?? "").trim().toLowerCase();
	if (!value) return "";
	const mention = value.match(/^<@([a-z0-9_]+)>$/i);
	if (mention?.[1]) return mention[1];
	return value.replace(/^(slack:|user:)/, "");
}
function isSlackStableUserId(value) {
	return /^[ubw][a-z0-9_]+$/i.test(value);
}
function normalizeSlackStableEntry(entry) {
	const normalized = entry.trim().toLowerCase();
	if (!normalized) return null;
	const userId = normalizeSlackUserId(normalized);
	return isSlackStableUserId(userId) ? userId : null;
}
function normalizeSlackNameEntry(entry) {
	const normalized = entry.trim().toLowerCase();
	if (!normalized || normalizeSlackStableEntry(normalized)) return null;
	return normalized.replace(/^slack:/, "") || null;
}
function normalizeSlackNameSubject(value) {
	return value.trim().toLowerCase() || null;
}
function normalizeSlackNameSlugEntry(entry) {
	const name = normalizeSlackNameEntry(entry);
	if (!name) return null;
	const slug = normalizeSlackSlug(name);
	return slug && slug !== name ? slug : null;
}
const slackIngressIdentity = defineStableChannelIngressIdentity({
	key: "senderId",
	kind: "stable-id",
	normalizeEntry: normalizeSlackStableEntry,
	normalizeSubject: normalizeSlackUserId,
	sensitivity: "pii",
	aliases: [["senderName", normalizeSlackNameEntry], ["senderNameSlug", normalizeSlackNameSlugEntry]].map(([key, normalizeEntry]) => ({
		key,
		kind: SLACK_USER_NAME_KIND,
		normalizeEntry,
		normalizeSubject: normalizeSlackNameSubject,
		dangerous: true,
		sensitivity: "pii"
	}))
});
function createSlackIngressSubject(params) {
	const senderId = normalizeSlackUserId(params.senderId);
	const senderName = params.senderName?.trim().toLowerCase();
	return {
		stableId: senderId,
		aliases: {
			senderName,
			senderNameSlug: senderName ? normalizeSlackSlug(senderName) : void 0
		}
	};
}
function createSlackIngressResolver(ctx) {
	return createChannelIngressResolver({
		channelId: SLACK_CHANNEL_ID,
		accountId: ctx.accountId,
		identity: slackIngressIdentity,
		cfg: ctx.cfg
	});
}
function readSlackCacheTtlMs(envName, fallback) {
	const raw = process.env[envName]?.trim();
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}
function getChannelMembersCache(ctx) {
	const existing = slackChannelMembersCache.get(ctx);
	if (existing) return existing;
	const next = /* @__PURE__ */ new Map();
	slackChannelMembersCache.set(ctx, next);
	return next;
}
function pruneChannelMembersCache(cache) {
	while (cache.size > CHANNEL_MEMBERS_CACHE_MAX) {
		const oldest = cache.keys().next();
		if (oldest.done) return;
		cache.delete(oldest.value);
	}
}
function buildBaseAllowFrom(ctx) {
	return normalizeAllowListLower(normalizeAllowList(ctx.allowFrom));
}
async function resolveSlackEffectiveAllowFrom(ctx, options) {
	const base = buildBaseAllowFrom(ctx);
	if (options?.includePairingStore !== true) return base;
	let storeAllowFrom = [];
	try {
		const resolved = await readChannelIngressStoreAllowFromForDmPolicy({
			provider: "slack",
			accountId: ctx.accountId,
			dmPolicy: ctx.dmPolicy
		});
		storeAllowFrom = Array.isArray(resolved) ? resolved : [];
	} catch {
		storeAllowFrom = [];
	}
	return normalizeAllowListLower([...base, ...storeAllowFrom]);
}
async function fetchSlackChannelMemberIds(ctx, channelId) {
	const members = /* @__PURE__ */ new Set();
	let cursor;
	do {
		const response = await ctx.app.client.conversations.members({
			token: ctx.botToken,
			channel: channelId,
			limit: 999,
			...cursor ? { cursor } : {}
		});
		for (const member of normalizeAllowListLower(response.members)) members.add(member);
		const nextCursor = response.response_metadata?.next_cursor?.trim();
		cursor = nextCursor ? nextCursor : void 0;
	} while (cursor);
	return members;
}
async function resolveSlackChannelMemberIds(ctx, channelId) {
	const cache = getChannelMembersCache(ctx);
	const key = `${ctx.accountId}:${channelId}`;
	const ttlMs = readSlackCacheTtlMs("OPENCLAW_SLACK_CHANNEL_MEMBERS_CACHE_TTL_MS", DEFAULT_CHANNEL_MEMBERS_CACHE_TTL_MS);
	const nowMs = Date.now();
	const cached = cache.get(key);
	if (ttlMs > 0 && cached?.members && cached.expiresAtMs >= nowMs) return cached.members;
	if (cached?.pending) return await cached.pending;
	const pending = fetchSlackChannelMemberIds(ctx, channelId);
	cache.set(key, {
		expiresAtMs: ttlMs > 0 ? nowMs + ttlMs : 0,
		pending
	});
	pruneChannelMembersCache(cache);
	try {
		const members = await pending;
		if (ttlMs > 0) {
			cache.set(key, {
				expiresAtMs: Date.now() + ttlMs,
				members
			});
			pruneChannelMembersCache(cache);
		} else cache.delete(key);
		return members;
	} finally {
		if (cache.get(key)?.pending === pending) cache.delete(key);
	}
}
function resolveExplicitSlackOwnerIds(allowFromLower) {
	const ownerIds = /* @__PURE__ */ new Set();
	for (const entry of allowFromLower) {
		const ownerId = normalizeSlackAllowOwnerEntry(entry);
		if (ownerId) ownerIds.add(ownerId);
	}
	return [...ownerIds];
}
async function authorizeSlackBotRoomMessage(params) {
	const channelUserAllowList = normalizeAllowListLower(params.channelUsers).filter((entry) => entry !== "*");
	if (channelUserAllowList.length > 0 && allowListMatches({
		allowList: channelUserAllowList,
		id: params.senderId,
		name: params.senderName,
		allowNameMatching: params.ctx.allowNameMatching
	})) return true;
	const explicitOwnerIds = resolveExplicitSlackOwnerIds(params.allowFromLower);
	if (explicitOwnerIds.length === 0) {
		logVerbose(`slack: drop bot message ${params.senderId} in ${params.channelId} (no explicit owner id for presence check)`);
		return false;
	}
	try {
		const channelMemberIds = await resolveSlackChannelMemberIds(params.ctx, params.channelId);
		if (explicitOwnerIds.some((ownerId) => channelMemberIds.has(ownerId))) return true;
		logVerbose(`slack: drop bot message ${params.senderId} in ${params.channelId} (no owner present)`);
	} catch (error) {
		logVerbose(`slack: drop bot message ${params.senderId} in ${params.channelId} (owner presence lookup failed: ${formatErrorMessage(error)})`);
	}
	return false;
}
function wildcardWhenOpen(entries) {
	return entries.length > 0 ? [...entries] : ["*"];
}
function slackIngressConversationKind(channelType) {
	return channelType === "im" ? "direct" : channelType === "mpim" ? "group" : "channel";
}
async function resolveSlackCommandIngress(params) {
	const isDirectMessage = params.channelType === "im";
	const channelUsers = normalizeAllowListLower(params.channelUsers);
	const channelUsersConfigured = !isDirectMessage && channelUsers.length > 0;
	return await createSlackIngressResolver(params.ctx).message({
		subject: createSlackIngressSubject({
			senderId: params.senderId,
			senderName: params.senderName
		}),
		conversation: {
			kind: slackIngressConversationKind(params.channelType),
			id: params.channelId
		},
		event: {
			kind: params.eventKind ?? "message",
			authMode: "inbound",
			mayPair: false
		},
		dmPolicy: isDirectMessage ? "open" : "disabled",
		groupPolicy: channelUsersConfigured ? "allowlist" : "open",
		policy: {
			groupAllowFromFallbackToAllowFrom: false,
			mutableIdentifierMatching: params.ctx.allowNameMatching ? "enabled" : "disabled",
			...params.activation ? { activation: params.activation } : {}
		},
		mentionFacts: params.mentionFacts,
		allowFrom: isDirectMessage ? ["*"] : params.ownerAllowFromLower,
		groupAllowFrom: channelUsersConfigured ? channelUsers : [],
		command: {
			allowTextCommands: params.allowTextCommands,
			hasControlCommand: params.hasControlCommand,
			modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
			...isDirectMessage ? { commandOwnerAllowFrom: params.ownerAllowFromLower } : {}
		}
	});
}
async function decideSlackSystemIngress(params) {
	const isDirectMessage = params.channelType === "im";
	const channelUsers = normalizeAllowListLower(params.channelUsers);
	const channelUsersConfigured = !isDirectMessage && channelUsers.length > 0;
	const ownerAllowFrom = params.interactiveEvent && channelUsersConfigured ? params.ownerAllowFromLower.filter((entry) => entry !== "*") : params.ownerAllowFromLower;
	const hasAnyCommandAllowlist = ownerAllowFrom.length > 0 || channelUsersConfigured;
	const groupAllowFrom = (() => {
		if (isDirectMessage) return [];
		if (params.interactiveEvent && hasAnyCommandAllowlist) return channelUsersConfigured ? channelUsers : [];
		if (channelUsersConfigured) return channelUsers;
		return params.channelId ? ["*"] : wildcardWhenOpen(params.ownerAllowFromLower);
	})();
	return (await createSlackIngressResolver(params.ctx).message({
		subject: createSlackIngressSubject({
			senderId: params.senderId,
			senderName: params.senderName
		}),
		conversation: {
			kind: slackIngressConversationKind(params.channelType),
			id: params.channelId ?? "slack-system"
		},
		event: {
			kind: params.interactiveEvent ? "button" : "system",
			authMode: params.interactiveEvent && hasAnyCommandAllowlist ? "command" : "inbound",
			mayPair: false
		},
		dmPolicy: isDirectMessage ? "open" : "disabled",
		groupPolicy: params.interactiveEvent && hasAnyCommandAllowlist ? "open" : channelUsersConfigured || !params.channelId && params.ownerAllowFromLower.length > 0 ? "allowlist" : "open",
		policy: {
			groupAllowFromFallbackToAllowFrom: false,
			mutableIdentifierMatching: params.ctx.allowNameMatching ? "enabled" : "disabled"
		},
		allowFrom: isDirectMessage ? wildcardWhenOpen(params.ownerAllowFromLower) : ownerAllowFrom,
		groupAllowFrom,
		command: params.interactiveEvent && hasAnyCommandAllowlist ? {
			useAccessGroups: true,
			allowTextCommands: true,
			modeWhenAccessGroupsOff: "configured",
			commandOwnerAllowFrom: ownerAllowFrom
		} : void 0
	})).ingress;
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
	if (params.interactiveEvent && !expectedSenderId) return {
		allowed: false,
		reason: "missing-expected-sender"
	};
	const channelId = params.channelId?.trim();
	let channelType = normalizeSlackChannelType(params.channelType, channelId);
	let channelName;
	if (channelId) {
		const info = await params.ctx.resolveChannelName(channelId).catch(() => ({}));
		channelName = info.name;
		const resolvedTypeSource = params.channelType ?? info.type;
		channelType = normalizeSlackChannelType(resolvedTypeSource, channelId);
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
		if (params.interactiveEvent) {
			const inferredFromId = inferSlackChannelType(channelId);
			const sourceNormalized = typeof resolvedTypeSource === "string" ? resolvedTypeSource.toLowerCase().trim() : void 0;
			if (inferredFromId === void 0 && !(sourceNormalized === "im" || sourceNormalized === "mpim" || sourceNormalized === "channel" || sourceNormalized === "group")) return {
				allowed: false,
				reason: "ambiguous-channel-type",
				channelType,
				channelName
			};
		}
	}
	const senderName = (await params.ctx.resolveUserName(senderId).catch(() => ({}))).name;
	const ingressChannelType = channelType ?? "channel";
	if (ingressChannelType === "im") {
		if (!params.ctx.dmEnabled || params.ctx.dmPolicy === "disabled") return {
			allowed: false,
			reason: "dm-disabled",
			channelType,
			channelName
		};
	}
	const allowFromLower = await resolveSlackEffectiveAllowFrom(params.ctx, { includePairingStore: ingressChannelType === "im" });
	const channelConfig = channelId ? resolveSlackChannelConfig({
		channelId,
		channelName,
		channels: params.ctx.channelsConfig,
		channelKeys: params.ctx.channelsConfigKeys,
		defaultRequireMention: params.ctx.defaultRequireMention,
		allowNameMatching: params.ctx.allowNameMatching
	}) : null;
	const channelUsersAllowlistConfigured = Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
	if ((await decideSlackSystemIngress({
		ctx: params.ctx,
		senderId,
		senderName,
		channelType: ingressChannelType,
		channelId,
		ownerAllowFromLower: allowFromLower,
		channelUsers: channelConfig?.users,
		interactiveEvent: params.interactiveEvent === true
	})).decision === "allow") return {
		allowed: true,
		channelType,
		channelName
	};
	if (channelType === "im" || !channelId) return {
		allowed: false,
		reason: "sender-not-allowlisted",
		...channelId ? {
			channelType,
			channelName
		} : {}
	};
	return {
		allowed: false,
		reason: params.interactiveEvent && channelUsersAllowlistConfigured && allowFromLower.length > 0 ? "sender-not-authorized" : channelUsersAllowlistConfigured ? "sender-not-channel-allowed" : "sender-not-allowlisted",
		channelType,
		channelName
	};
}
//#endregion
//#region extensions/slack/src/monitor/dm-auth.ts
async function authorizeSlackDirectMessage(params) {
	if (!params.ctx.dmEnabled || params.ctx.dmPolicy === "disabled") {
		await params.onDisabled();
		return false;
	}
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
		await createChannelPairingChallengeIssuer({
			channel: "slack",
			upsertPairingRequest: async ({ id, meta }) => await upsertChannelPairingRequest({
				channel: "slack",
				id,
				accountId: params.accountId,
				meta
			})
		})({
			senderId: params.senderId,
			senderIdLine: `Your Slack user id: ${params.senderId}`,
			meta: { name: senderName },
			sendPairingReply: params.sendPairingReply,
			onCreated: () => {
				params.log(`slack pairing request sender=${params.senderId} name=${senderName ?? "unknown"} (${allowMatchMeta})`);
			},
			onReplyError: (err) => {
				params.log(`slack pairing reply failed for ${params.senderId}: ${formatErrorMessage(err)}`);
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
	const untrustedChannelMetadata = params.isRoomish ? buildUntrustedChannelMetadata({
		source: "slack",
		label: "Slack channel description",
		entries: [params.channelInfo?.topic, params.channelInfo?.purpose]
	}) : void 0;
	const systemPromptParts = [params.isRoomish ? normalizeOptionalString(params.channelConfig?.systemPrompt) ?? null : null].filter((entry) => Boolean(entry));
	return {
		untrustedChannelMetadata,
		groupSystemPrompt: systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : void 0
	};
}
//#endregion
export { resolveSlackCommandIngress as a, isSlackChannelAllowedByPolicy as c, resolveSlackChannelConfig as d, resolveSlackChannelLabel as f, stripSlackMentionsForCommandDetection as h, authorizeSlackSystemEventSender as i, normalizeSlackChannelType as l, resolveSlackSlashCommandConfig as m, authorizeSlackDirectMessage as n, resolveSlackEffectiveAllowFrom as o, buildSlackSlashCommandMatcher as p, authorizeSlackBotRoomMessage as r, createSlackMonitorContext as s, resolveSlackRoomContextHints as t, resolveSlackChatType as u };
