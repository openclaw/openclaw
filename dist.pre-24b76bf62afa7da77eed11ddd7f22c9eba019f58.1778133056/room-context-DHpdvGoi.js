import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { S as resolveDefaultAgentId } from "./agent-scope-eOlEQiLx.js";
import { i as getChildLogger } from "./logger-rPxGv0hY.js";
import { r as logVerbose } from "./globals-Byqe4NlR.js";
import { t as createDedupeCache } from "./dedupe-D9kHxx0u.js";
import { a as resolveChannelEntryMatchWithFallback, n as buildChannelKeyCandidates, t as applyChannelMatchMeta } from "./channel-config-CRL3C52q.js";
import { n as formatAllowlistMatchMeta } from "./allowlist-match-BS5FqXk-.js";
import { n as resolveSessionKey } from "./session-key-CLqXY2dR.js";
import { i as resolveAgentRoute } from "./resolve-route-de-5zuJ-.js";
import "./text-runtime-C_zPTqpT.js";
import "./routing-MIJf671J.js";
import "./error-runtime-ByBXRpxU.js";
import { d as upsertChannelPairingRequest } from "./pairing-store-BlGIjT_b.js";
import { t as evaluateGroupRouteAccessForPolicy } from "./group-access-C0bxOoE2.js";
import { n as readStoreAllowFromForDmPolicy } from "./dm-policy-shared-C7MlRVkr.js";
import "./channel-targets-DHuX-MKO.js";
import { t as createChannelPairingChallengeIssuer } from "./channel-pairing-CWWMPhAh.js";
import "./runtime-env-BdFx1dy-.js";
import "./runtime-config-snapshot-NuaB0TUN.js";
import "./conversation-runtime-BKVIWKi4.js";
import "./agent-runtime-Bw1oNb-Q.js";
import { t as buildUntrustedChannelMetadata } from "./security-runtime-DD1ay_UN.js";
import "./session-store-runtime-DcbeOoK4.js";
import { a as normalizeSlackSlug, i as normalizeSlackAllowOwnerEntry, n as normalizeAllowList, o as resolveSlackAllowListMatch, r as normalizeAllowListLower, s as resolveSlackUserAllowed, t as allowListMatches } from "./allow-list-vtzciw-b.js";
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
	return evaluateGroupRouteAccessForPolicy({
		groupPolicy: params.groupPolicy,
		routeAllowlistConfigured: params.channelAllowlistConfigured,
		routeMatched: params.channelAllowed
	}).allowed;
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
		}, params.mainKey, resolveDefaultAgentId(params.cfg));
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
			logVerbose(`slack status update failed for channel ${p.channelId}: ${formatErrorMessage(err)}`);
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
let slackAllowFromCache = /* @__PURE__ */ new WeakMap();
let slackChannelMembersCache = /* @__PURE__ */ new WeakMap();
const DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS = 5e3;
const DEFAULT_CHANNEL_MEMBERS_CACHE_TTL_MS = 6e4;
const CHANNEL_MEMBERS_CACHE_MAX = 512;
function getPairingAllowFromCacheTtlMs() {
	const raw = process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS?.trim();
	if (!raw) return DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS;
	return Math.max(0, Math.floor(parsed));
}
function getChannelMembersCacheTtlMs() {
	const raw = process.env.OPENCLAW_SLACK_CHANNEL_MEMBERS_CACHE_TTL_MS?.trim();
	if (!raw) return DEFAULT_CHANNEL_MEMBERS_CACHE_TTL_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_CHANNEL_MEMBERS_CACHE_TTL_MS;
	return Math.max(0, Math.floor(parsed));
}
function getAllowFromCacheState(ctx) {
	const existing = slackAllowFromCache.get(ctx);
	if (existing) return existing;
	const next = {};
	slackAllowFromCache.set(ctx, next);
	return next;
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
	const ttlMs = getChannelMembersCacheTtlMs();
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
	const resolveAllowFromLower = async (includePairingStore = false) => (await resolveSlackEffectiveAllowFrom(params.ctx, { includePairingStore })).allowFromLower;
	if (channelType === "im") {
		if (!params.ctx.dmEnabled || params.ctx.dmPolicy === "disabled") return {
			allowed: false,
			reason: "dm-disabled",
			channelType,
			channelName
		};
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
		const allowFromLower = await resolveAllowFromLower(false);
		const ownerAllowlistConfigured = allowFromLower.length > 0;
		const allowFromLowerWithoutWildcard = allowFromLower.filter((entry) => entry !== "*");
		const channelConfig = resolveSlackChannelConfig({
			channelId,
			channelName,
			channels: params.ctx.channelsConfig,
			channelKeys: params.ctx.channelsConfigKeys,
			defaultRequireMention: params.ctx.defaultRequireMention,
			allowNameMatching: params.ctx.allowNameMatching
		});
		const channelUsersAllowlistConfigured = Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
		const ownerAllowed = (ownerAllowlistConfigured ? resolveSlackAllowListMatch({
			allowList: allowFromLower,
			id: senderId,
			name: senderName,
			allowNameMatching: params.ctx.allowNameMatching
		}) : { allowed: false }).allowed;
		const ownerExplicitlyAllowed = allowFromLowerWithoutWildcard.length > 0 && resolveSlackAllowListMatch({
			allowList: allowFromLowerWithoutWildcard,
			id: senderId,
			name: senderName,
			allowNameMatching: params.ctx.allowNameMatching
		}).allowed;
		if (channelUsersAllowlistConfigured) {
			if (resolveSlackUserAllowed({
				allowList: channelConfig?.users,
				userId: senderId,
				userName: senderName,
				allowNameMatching: params.ctx.allowNameMatching
			}) || params.interactiveEvent && ownerExplicitlyAllowed) return {
				allowed: true,
				channelType,
				channelName
			};
			return {
				allowed: false,
				reason: params.interactiveEvent && ownerAllowlistConfigured ? "sender-not-authorized" : "sender-not-channel-allowed",
				channelType,
				channelName
			};
		}
		if (params.interactiveEvent && ownerAllowed) return {
			allowed: true,
			channelType,
			channelName
		};
		if (params.interactiveEvent && ownerAllowlistConfigured) return {
			allowed: false,
			reason: "sender-not-allowlisted",
			channelType,
			channelName
		};
	}
	return {
		allowed: true,
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
export { resolveSlackEffectiveAllowFrom as a, normalizeSlackChannelType as c, resolveSlackChannelLabel as d, buildSlackSlashCommandMatcher as f, authorizeSlackSystemEventSender as i, resolveSlackChatType as l, stripSlackMentionsForCommandDetection as m, authorizeSlackDirectMessage as n, createSlackMonitorContext as o, resolveSlackSlashCommandConfig as p, authorizeSlackBotRoomMessage as r, isSlackChannelAllowedByPolicy as s, resolveSlackRoomContextHints as t, resolveSlackChannelConfig as u };
