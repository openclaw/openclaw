import { A as listEnabledDiscordAccounts, C as loadWebMediaRaw, D as normalizePollInput, E as normalizePollDurationHours, M as normalizeDiscordToken, O as buildOutboundMediaLoadOptions, S as loadWebMedia, b as chunkMarkdownTextWithMode, f as createDiscordRetryRunner, i as renderMarkdownWithMarkers, j as resolveDiscordAccount, k as createDiscordActionGate, n as listTokenSourcedAccounts, o as markdownToIRWithMeta, r as assertMediaNotDataUrl, s as resolveMarkdownTableMode, t as createUnionActionGate, x as resolveChunkMode } from "../../../shared-U9vjjY5W.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../../account-id-JwW97xNZ.js";
import { a as parseAvailableTags, c as readStringArrayParam, g as extensionForMime, i as jsonResult, n as resolveFetch, o as readNumberParam, s as readReactionParams, t as resolveReactionMessageId, u as readStringParam, x as maxBytesForKind } from "../../../reaction-message-id-BNtk-P2G.js";
import { N as resolvePreferredOpenClawTmpDir } from "../../../utils-DZ2oAc5g.js";
import { t as loadConfig, v as resolveRetryConfig, y as retryAsync } from "../../../config-CpCccDYR.js";
import "../../../accounts-DF4yluvz.js";
import { t as recordChannelActivity } from "../../../channel-activity-DUOy6BRw.js";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, Routes } from "discord-api-types/v10";
import { Button, ChannelSelectMenu, Container, Embed, File, LinkButton, MediaGallery, MentionableSelectMenu, RateLimitError, RequestClient, RoleSelectMenu, Row, Section, Separator, StringSelectMenu, TextDisplay, Thumbnail, UserSelectMenu, serializePayload } from "@buape/carbon";
import { PollLayoutType } from "discord-api-types/payloads/v10";
import crypto from "node:crypto";

//#region src/agents/tools/discord-actions-shared.ts
function readDiscordParentIdParam(params) {
	if (params.clearParent === true) return null;
	if (params.parentId === null) return null;
	return readStringParam(params, "parentId");
}

//#endregion
//#region src/discord/monitor/presence-cache.ts
const presenceCache = /* @__PURE__ */ new Map();
function resolveAccountKey$1(accountId) {
	return accountId ?? "default";
}
/** Get cached presence for a user. Returns undefined if not cached. */
function getPresence(accountId, userId) {
	return presenceCache.get(resolveAccountKey$1(accountId))?.get(userId);
}

//#endregion
//#region src/discord/chunk.ts
const DEFAULT_MAX_CHARS = 2e3;
const DEFAULT_MAX_LINES = 17;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
function countLines(text) {
	if (!text) return 0;
	return text.split("\n").length;
}
function parseFenceLine(line) {
	const match = line.match(FENCE_RE);
	if (!match) return null;
	const indent = match[1] ?? "";
	const marker = match[2] ?? "";
	return {
		indent,
		markerChar: marker[0] ?? "`",
		markerLen: marker.length,
		openLine: line
	};
}
function closeFenceLine(openFence) {
	return `${openFence.indent}${openFence.markerChar.repeat(openFence.markerLen)}`;
}
function closeFenceIfNeeded(text, openFence) {
	if (!openFence) return text;
	const closeLine = closeFenceLine(openFence);
	if (!text) return closeLine;
	if (!text.endsWith("\n")) return `${text}\n${closeLine}`;
	return `${text}${closeLine}`;
}
function splitLongLine(line, maxChars, opts) {
	const limit = Math.max(1, Math.floor(maxChars));
	if (line.length <= limit) return [line];
	const out = [];
	let remaining = line;
	while (remaining.length > limit) {
		if (opts.preserveWhitespace) {
			out.push(remaining.slice(0, limit));
			remaining = remaining.slice(limit);
			continue;
		}
		const window = remaining.slice(0, limit);
		let breakIdx = -1;
		for (let i = window.length - 1; i >= 0; i--) if (/\s/.test(window[i])) {
			breakIdx = i;
			break;
		}
		if (breakIdx <= 0) breakIdx = limit;
		out.push(remaining.slice(0, breakIdx));
		remaining = remaining.slice(breakIdx);
	}
	if (remaining.length) out.push(remaining);
	return out;
}
/**
* Chunks outbound Discord text by both character count and (soft) line count,
* while keeping fenced code blocks balanced across chunks.
*/
function chunkDiscordText(text, opts = {}) {
	const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS));
	const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES));
	const body = text ?? "";
	if (!body) return [];
	if (body.length <= maxChars && countLines(body) <= maxLines) return [body];
	const lines = body.split("\n");
	const chunks = [];
	let current = "";
	let currentLines = 0;
	let openFence = null;
	const flush = () => {
		if (!current) return;
		const payload = closeFenceIfNeeded(current, openFence);
		if (payload.trim().length) chunks.push(payload);
		current = "";
		currentLines = 0;
		if (openFence) {
			current = openFence.openLine;
			currentLines = 1;
		}
	};
	for (const originalLine of lines) {
		const fenceInfo = parseFenceLine(originalLine);
		const wasInsideFence = openFence !== null;
		let nextOpenFence = openFence;
		if (fenceInfo) {
			if (!openFence) nextOpenFence = fenceInfo;
			else if (openFence.markerChar === fenceInfo.markerChar && fenceInfo.markerLen >= openFence.markerLen) nextOpenFence = null;
		}
		const reserveChars = nextOpenFence ? closeFenceLine(nextOpenFence).length + 1 : 0;
		const reserveLines = nextOpenFence ? 1 : 0;
		const effectiveMaxChars = maxChars - reserveChars;
		const effectiveMaxLines = maxLines - reserveLines;
		const charLimit = effectiveMaxChars > 0 ? effectiveMaxChars : maxChars;
		const lineLimit = effectiveMaxLines > 0 ? effectiveMaxLines : maxLines;
		const prefixLen = current.length > 0 ? current.length + 1 : 0;
		const segments = splitLongLine(originalLine, Math.max(1, charLimit - prefixLen), { preserveWhitespace: wasInsideFence });
		for (let segIndex = 0; segIndex < segments.length; segIndex++) {
			const segment = segments[segIndex];
			const isLineContinuation = segIndex > 0;
			const addition = `${isLineContinuation ? "" : current.length > 0 ? "\n" : ""}${segment}`;
			const nextLen = current.length + addition.length;
			const nextLines = currentLines + (isLineContinuation ? 0 : 1);
			if ((nextLen > charLimit || nextLines > lineLimit) && current.length > 0) flush();
			if (current.length > 0) {
				current += addition;
				if (!isLineContinuation) currentLines += 1;
			} else {
				current = segment;
				currentLines = 1;
			}
		}
		openFence = nextOpenFence;
	}
	if (current.length) {
		const payload = closeFenceIfNeeded(current, openFence);
		if (payload.trim().length) chunks.push(payload);
	}
	return rebalanceReasoningItalics(text, chunks);
}
function chunkDiscordTextWithMode(text, opts) {
	if ((opts.chunkMode ?? "length") !== "newline") return chunkDiscordText(text, opts);
	const lineChunks = chunkMarkdownTextWithMode(text, Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS)), "newline");
	const chunks = [];
	for (const line of lineChunks) {
		const nested = chunkDiscordText(line, opts);
		if (!nested.length && line) {
			chunks.push(line);
			continue;
		}
		chunks.push(...nested);
	}
	return chunks;
}
function rebalanceReasoningItalics(source, chunks) {
	if (chunks.length <= 1) return chunks;
	if (!(source.startsWith("Reasoning:\n_") && source.trimEnd().endsWith("_"))) return chunks;
	const adjusted = [...chunks];
	for (let i = 0; i < adjusted.length; i++) {
		const isLast = i === adjusted.length - 1;
		const current = adjusted[i];
		if (!current.trimEnd().endsWith("_")) adjusted[i] = `${current}_`;
		if (isLast) break;
		const next = adjusted[i + 1];
		const leadingWhitespaceLen = next.length - next.trimStart().length;
		const leadingWhitespace = next.slice(0, leadingWhitespaceLen);
		const nextBody = next.slice(leadingWhitespaceLen);
		if (!nextBody.startsWith("_")) adjusted[i + 1] = `${leadingWhitespace}_${nextBody}`;
	}
	return adjusted;
}

//#endregion
//#region src/discord/client.ts
function resolveToken(params) {
	const explicit = normalizeDiscordToken(params.explicit, "channels.discord.token");
	if (explicit) return explicit;
	const fallback = normalizeDiscordToken(params.fallbackToken, "channels.discord.token");
	if (!fallback) throw new Error(`Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`);
	return fallback;
}
function resolveRest(token, rest) {
	return rest ?? new RequestClient(token);
}
function createDiscordRestClient(opts, cfg = loadConfig()) {
	const account = resolveDiscordAccount({
		cfg,
		accountId: opts.accountId
	});
	const token = resolveToken({
		explicit: opts.token,
		accountId: account.accountId,
		fallbackToken: account.token
	});
	return {
		token,
		rest: resolveRest(token, opts.rest),
		account
	};
}
function createDiscordClient(opts, cfg = loadConfig()) {
	const { token, rest, account } = createDiscordRestClient(opts, cfg);
	return {
		token,
		rest,
		request: createDiscordRetryRunner({
			retry: opts.retry,
			configRetry: account.config.retry,
			verbose: opts.verbose
		})
	};
}
function resolveDiscordRest(opts) {
	return createDiscordRestClient(opts).rest;
}

//#endregion
//#region src/discord/send.permissions.ts
const PERMISSION_ENTRIES = Object.entries(PermissionFlagsBits).filter(([, value]) => typeof value === "bigint");
const ALL_PERMISSIONS = PERMISSION_ENTRIES.reduce((acc, [, value]) => acc | value, 0n);
const ADMINISTRATOR_BIT = PermissionFlagsBits.Administrator;
function addPermissionBits(base, add) {
	if (!add) return base;
	return base | BigInt(add);
}
function removePermissionBits(base, deny) {
	if (!deny) return base;
	return base & ~BigInt(deny);
}
function bitfieldToPermissions(bitfield) {
	return PERMISSION_ENTRIES.filter(([, value]) => (bitfield & value) === value).map(([name]) => name).toSorted();
}
function hasAdministrator(bitfield) {
	return (bitfield & ADMINISTRATOR_BIT) === ADMINISTRATOR_BIT;
}
function hasPermissionBit(bitfield, permission) {
	return (bitfield & permission) === permission;
}
function isThreadChannelType(channelType) {
	return channelType === ChannelType.GuildNewsThread || channelType === ChannelType.GuildPublicThread || channelType === ChannelType.GuildPrivateThread;
}
async function fetchBotUserId(rest) {
	const me = await rest.get(Routes.user("@me"));
	if (!me?.id) throw new Error("Failed to resolve bot user id");
	return me.id;
}
/**
* Fetch guild-level permissions for a user. This does not include channel-specific overwrites.
*/
async function fetchMemberGuildPermissionsDiscord(guildId, userId, opts = {}) {
	const rest = resolveDiscordRest(opts);
	try {
		const [guild, member] = await Promise.all([rest.get(Routes.guild(guildId)), rest.get(Routes.guildMember(guildId, userId))]);
		const rolesById = new Map((guild.roles ?? []).map((role) => [role.id, role]));
		const everyoneRole = rolesById.get(guildId);
		let permissions = 0n;
		if (everyoneRole?.permissions) permissions = addPermissionBits(permissions, everyoneRole.permissions);
		for (const roleId of member.roles ?? []) {
			const role = rolesById.get(roleId);
			if (role?.permissions) permissions = addPermissionBits(permissions, role.permissions);
		}
		return permissions;
	} catch {
		return null;
	}
}
/**
* Returns true when the user has ADMINISTRATOR or required permission bits
* matching the provided predicate.
*/
async function hasGuildPermissionsDiscord(guildId, userId, requiredPermissions, check, opts = {}) {
	const permissions = await fetchMemberGuildPermissionsDiscord(guildId, userId, opts);
	if (permissions === null) return false;
	if (hasAdministrator(permissions)) return true;
	return check(permissions, requiredPermissions);
}
/**
* Returns true when the user has ADMINISTRATOR or any required permission bit.
*/
async function hasAnyGuildPermissionDiscord(guildId, userId, requiredPermissions, opts = {}) {
	return await hasGuildPermissionsDiscord(guildId, userId, requiredPermissions, (permissions, required) => required.some((permission) => hasPermissionBit(permissions, permission)), opts);
}
async function fetchChannelPermissionsDiscord(channelId, opts = {}) {
	const rest = resolveDiscordRest(opts);
	const channel = await rest.get(Routes.channel(channelId));
	const channelType = "type" in channel ? channel.type : void 0;
	const guildId = "guild_id" in channel ? channel.guild_id : void 0;
	if (!guildId) return {
		channelId,
		permissions: [],
		raw: "0",
		isDm: true,
		channelType
	};
	const botId = await fetchBotUserId(rest);
	const [guild, member] = await Promise.all([rest.get(Routes.guild(guildId)), rest.get(Routes.guildMember(guildId, botId))]);
	const rolesById = new Map((guild.roles ?? []).map((role) => [role.id, role]));
	const everyoneRole = rolesById.get(guildId);
	let base = 0n;
	if (everyoneRole?.permissions) base = addPermissionBits(base, everyoneRole.permissions);
	for (const roleId of member.roles ?? []) {
		const role = rolesById.get(roleId);
		if (role?.permissions) base = addPermissionBits(base, role.permissions);
	}
	if (hasAdministrator(base)) return {
		channelId,
		guildId,
		permissions: bitfieldToPermissions(ALL_PERMISSIONS),
		raw: ALL_PERMISSIONS.toString(),
		isDm: false,
		channelType
	};
	let permissions = base;
	const overwrites = "permission_overwrites" in channel ? channel.permission_overwrites ?? [] : [];
	for (const overwrite of overwrites) if (overwrite.id === guildId) {
		permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
		permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
	}
	for (const overwrite of overwrites) if (member.roles?.includes(overwrite.id)) {
		permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
		permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
	}
	for (const overwrite of overwrites) if (overwrite.id === botId) {
		permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
		permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
	}
	return {
		channelId,
		guildId,
		permissions: bitfieldToPermissions(permissions),
		raw: permissions.toString(),
		isDm: false,
		channelType
	};
}

//#endregion
//#region src/discord/send.types.ts
var DiscordSendError = class extends Error {
	constructor(message, opts) {
		super(message);
		this.name = "DiscordSendError";
		if (opts) Object.assign(this, opts);
	}
	toString() {
		return this.message;
	}
};
const DISCORD_MAX_EMOJI_BYTES = 256 * 1024;
const DISCORD_MAX_STICKER_BYTES = 512 * 1024;

//#endregion
//#region src/channels/targets.ts
function normalizeTargetId(kind, id) {
	return `${kind}:${id}`.toLowerCase();
}
function buildMessagingTarget(kind, id, raw) {
	return {
		kind,
		id,
		raw,
		normalized: normalizeTargetId(kind, id)
	};
}
function ensureTargetId(params) {
	if (!params.pattern.test(params.candidate)) throw new Error(params.errorMessage);
	return params.candidate;
}
function parseTargetMention(params) {
	const match = params.raw.match(params.mentionPattern);
	if (!match?.[1]) return;
	return buildMessagingTarget(params.kind, match[1], params.raw);
}
function parseTargetPrefix(params) {
	if (!params.raw.startsWith(params.prefix)) return;
	const id = params.raw.slice(params.prefix.length).trim();
	return id ? buildMessagingTarget(params.kind, id, params.raw) : void 0;
}
function parseTargetPrefixes(params) {
	for (const entry of params.prefixes) {
		const parsed = parseTargetPrefix({
			raw: params.raw,
			prefix: entry.prefix,
			kind: entry.kind
		});
		if (parsed) return parsed;
	}
}
function parseAtUserTarget(params) {
	if (!params.raw.startsWith("@")) return;
	return buildMessagingTarget("user", ensureTargetId({
		candidate: params.raw.slice(1).trim(),
		pattern: params.pattern,
		errorMessage: params.errorMessage
	}), params.raw);
}
function parseMentionPrefixOrAtUserTarget(params) {
	const mentionTarget = parseTargetMention({
		raw: params.raw,
		mentionPattern: params.mentionPattern,
		kind: "user"
	});
	if (mentionTarget) return mentionTarget;
	const prefixedTarget = parseTargetPrefixes({
		raw: params.raw,
		prefixes: params.prefixes
	});
	if (prefixedTarget) return prefixedTarget;
	return parseAtUserTarget({
		raw: params.raw,
		pattern: params.atUserPattern,
		errorMessage: params.atUserErrorMessage
	});
}
function requireTargetKind(params) {
	const kindLabel = params.kind;
	if (!params.target) throw new Error(`${params.platform} ${kindLabel} id is required.`);
	if (params.target.kind !== params.kind) throw new Error(`${params.platform} ${kindLabel} id is required (use ${kindLabel}:<id>).`);
	return params.target.id;
}

//#endregion
//#region src/discord/directory-cache.ts
const DISCORD_DIRECTORY_CACHE_MAX_ENTRIES = 4e3;
const DISCORD_DISCRIMINATOR_SUFFIX = /#\d{4}$/;
const DIRECTORY_HANDLE_CACHE = /* @__PURE__ */ new Map();
function normalizeAccountCacheKey(accountId) {
	return normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID) || DEFAULT_ACCOUNT_ID;
}
function normalizeSnowflake$1(value) {
	const text = String(value ?? "").trim();
	if (!/^\d+$/.test(text)) return null;
	return text;
}
function normalizeHandleKey(raw) {
	let handle = raw.trim();
	if (!handle) return null;
	if (handle.startsWith("@")) handle = handle.slice(1).trim();
	if (!handle || /\s/.test(handle)) return null;
	return handle.toLowerCase();
}
function ensureAccountCache(accountId) {
	const cacheKey = normalizeAccountCacheKey(accountId);
	const existing = DIRECTORY_HANDLE_CACHE.get(cacheKey);
	if (existing) return existing;
	const created = /* @__PURE__ */ new Map();
	DIRECTORY_HANDLE_CACHE.set(cacheKey, created);
	return created;
}
function setCacheEntry(cache, key, userId) {
	if (cache.has(key)) cache.delete(key);
	cache.set(key, userId);
	if (cache.size <= DISCORD_DIRECTORY_CACHE_MAX_ENTRIES) return;
	const oldest = cache.keys().next();
	if (!oldest.done) cache.delete(oldest.value);
}
function rememberDiscordDirectoryUser(params) {
	const userId = normalizeSnowflake$1(params.userId);
	if (!userId) return;
	const cache = ensureAccountCache(params.accountId);
	for (const candidate of params.handles) {
		if (typeof candidate !== "string") continue;
		const handle = normalizeHandleKey(candidate);
		if (!handle) continue;
		setCacheEntry(cache, handle, userId);
		const withoutDiscriminator = handle.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
		if (withoutDiscriminator && withoutDiscriminator !== handle) setCacheEntry(cache, withoutDiscriminator, userId);
	}
}
function resolveDiscordDirectoryUserId(params) {
	const cache = DIRECTORY_HANDLE_CACHE.get(normalizeAccountCacheKey(params.accountId));
	if (!cache) return;
	const handle = normalizeHandleKey(params.handle);
	if (!handle) return;
	const direct = cache.get(handle);
	if (direct) return direct;
	const withoutDiscriminator = handle.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
	if (!withoutDiscriminator || withoutDiscriminator === handle) return;
	return cache.get(withoutDiscriminator);
}

//#endregion
//#region src/discord/api.ts
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_API_RETRY_DEFAULTS = {
	attempts: 3,
	minDelayMs: 500,
	maxDelayMs: 3e4,
	jitter: .1
};
function parseDiscordApiErrorPayload(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
	try {
		const payload = JSON.parse(trimmed);
		if (payload && typeof payload === "object") return payload;
	} catch {
		return null;
	}
	return null;
}
function parseRetryAfterSeconds(text, response) {
	const payload = parseDiscordApiErrorPayload(text);
	const retryAfter = payload && typeof payload.retry_after === "number" && Number.isFinite(payload.retry_after) ? payload.retry_after : void 0;
	if (retryAfter !== void 0) return retryAfter;
	const header = response.headers.get("Retry-After");
	if (!header) return;
	const parsed = Number(header);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function formatRetryAfterSeconds(value) {
	if (value === void 0 || !Number.isFinite(value) || value < 0) return;
	return `${value < 10 ? value.toFixed(1) : Math.round(value).toString()}s`;
}
function formatDiscordApiErrorText(text) {
	const trimmed = text.trim();
	if (!trimmed) return;
	const payload = parseDiscordApiErrorPayload(trimmed);
	if (!payload) return trimmed.startsWith("{") && trimmed.endsWith("}") ? "unknown error" : trimmed;
	const message = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : "unknown error";
	const retryAfter = formatRetryAfterSeconds(typeof payload.retry_after === "number" ? payload.retry_after : void 0);
	return retryAfter ? `${message} (retry after ${retryAfter})` : message;
}
var DiscordApiError = class extends Error {
	constructor(message, status, retryAfter) {
		super(message);
		this.status = status;
		this.retryAfter = retryAfter;
	}
};
async function fetchDiscord(path, token, fetcher = fetch, options) {
	const fetchImpl = resolveFetch(fetcher);
	if (!fetchImpl) throw new Error("fetch is not available");
	return retryAsync(async () => {
		const res = await fetchImpl(`${DISCORD_API_BASE}${path}`, { headers: { Authorization: `Bot ${token}` } });
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			const detail = formatDiscordApiErrorText(text);
			const suffix = detail ? `: ${detail}` : "";
			const retryAfter = res.status === 429 ? parseRetryAfterSeconds(text, res) : void 0;
			throw new DiscordApiError(`Discord API ${path} failed (${res.status})${suffix}`, res.status, retryAfter);
		}
		return await res.json();
	}, {
		...resolveRetryConfig(DISCORD_API_RETRY_DEFAULTS, options?.retry),
		label: options?.label ?? path,
		shouldRetry: (err) => err instanceof DiscordApiError && err.status === 429,
		retryAfterMs: (err) => err instanceof DiscordApiError && typeof err.retryAfter === "number" ? err.retryAfter * 1e3 : void 0
	});
}

//#endregion
//#region src/discord/directory-live.ts
function normalizeQuery(value) {
	return value?.trim().toLowerCase() ?? "";
}
function buildUserRank(user) {
	return user.bot ? 0 : 1;
}
function resolveDiscordDirectoryAccess(params) {
	const token = normalizeDiscordToken(resolveDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).token, "channels.discord.token");
	if (!token) return null;
	return {
		token,
		query: normalizeQuery(params.query)
	};
}
async function listDiscordGuilds(token) {
	return (await fetchDiscord("/users/@me/guilds", token)).filter((guild) => guild.id && guild.name);
}
async function listDiscordDirectoryPeersLive(params) {
	const access = resolveDiscordDirectoryAccess(params);
	if (!access) return [];
	const { token, query } = access;
	if (!query) return [];
	const guilds = await listDiscordGuilds(token);
	const rows = [];
	const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 25;
	for (const guild of guilds) {
		const paramsObj = new URLSearchParams({
			query,
			limit: String(Math.min(limit, 100))
		});
		const members = await fetchDiscord(`/guilds/${guild.id}/members/search?${paramsObj.toString()}`, token);
		for (const member of members) {
			const user = member.user;
			if (!user?.id) continue;
			rememberDiscordDirectoryUser({
				accountId: params.accountId,
				userId: user.id,
				handles: [
					user.username,
					user.global_name,
					member.nick,
					user.username ? `@${user.username}` : null
				]
			});
			const name = member.nick?.trim() || user.global_name?.trim() || user.username?.trim();
			rows.push({
				kind: "user",
				id: `user:${user.id}`,
				name: name || void 0,
				handle: user.username ? `@${user.username}` : void 0,
				rank: buildUserRank(user),
				raw: member
			});
			if (rows.length >= limit) return rows;
		}
	}
	return rows;
}

//#endregion
//#region src/discord/targets.ts
function parseDiscordTarget(raw, options = {}) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	const userTarget = parseMentionPrefixOrAtUserTarget({
		raw: trimmed,
		mentionPattern: /^<@!?(\d+)>$/,
		prefixes: [
			{
				prefix: "user:",
				kind: "user"
			},
			{
				prefix: "channel:",
				kind: "channel"
			},
			{
				prefix: "discord:",
				kind: "user"
			}
		],
		atUserPattern: /^\d+$/,
		atUserErrorMessage: "Discord DMs require a user id (use user:<id> or a <@id> mention)"
	});
	if (userTarget) return userTarget;
	if (/^\d+$/.test(trimmed)) {
		if (options.defaultKind) return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
		throw new Error(options.ambiguousMessage ?? `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`);
	}
	return buildMessagingTarget("channel", trimmed, trimmed);
}
function resolveDiscordChannelId(raw) {
	return requireTargetKind({
		platform: "Discord",
		target: parseDiscordTarget(raw, { defaultKind: "channel" }),
		kind: "channel"
	});
}
/**
* Resolve a Discord username to user ID using the directory lookup.
* This enables sending DMs by username instead of requiring explicit user IDs.
*
* @param raw - The username or raw target string (e.g., "john.doe")
* @param options - Directory configuration params (cfg, accountId, limit)
* @param parseOptions - Messaging target parsing options (defaults, ambiguity message)
* @returns Parsed MessagingTarget with user ID, or undefined if not found
*/
async function resolveDiscordTarget(raw, options, parseOptions = {}) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	const likelyUsername = isLikelyUsername(trimmed);
	const shouldLookup = isExplicitUserLookup(trimmed, parseOptions) || likelyUsername;
	const directParse = safeParseDiscordTarget(trimmed, parseOptions);
	if (directParse && directParse.kind !== "channel" && !likelyUsername) return directParse;
	if (!shouldLookup) return directParse ?? parseDiscordTarget(trimmed, parseOptions);
	try {
		const match = (await listDiscordDirectoryPeersLive({
			...options,
			query: trimmed,
			limit: 1
		}))[0];
		if (match && match.kind === "user") {
			const userId = match.id.replace(/^user:/, "");
			rememberDiscordDirectoryUser({
				accountId: options.accountId,
				userId,
				handles: [
					trimmed,
					match.name,
					match.handle
				]
			});
			return buildMessagingTarget("user", userId, trimmed);
		}
	} catch {}
	return parseDiscordTarget(trimmed, parseOptions);
}
function safeParseDiscordTarget(input, options) {
	try {
		return parseDiscordTarget(input, options);
	} catch {
		return;
	}
}
function isExplicitUserLookup(input, options) {
	if (/^<@!?(\d+)>$/.test(input)) return true;
	if (/^(user:|discord:)/.test(input)) return true;
	if (input.startsWith("@")) return true;
	if (/^\d+$/.test(input)) return options.defaultKind === "user";
	return false;
}
/**
* Check if a string looks like a Discord username (not a mention, prefix, or ID).
* Usernames typically don't start with special characters except underscore.
*/
function isLikelyUsername(input) {
	if (/^(user:|channel:|discord:|@|<@!?)|[\d]+$/.test(input)) return false;
	return true;
}

//#endregion
//#region src/discord/send.shared.ts
const DISCORD_TEXT_LIMIT = 2e3;
const DISCORD_MAX_STICKERS = 3;
const DISCORD_POLL_MAX_ANSWERS = 10;
const DISCORD_POLL_MAX_DURATION_HOURS = 768;
const DISCORD_MISSING_PERMISSIONS = 50013;
const DISCORD_CANNOT_DM = 50007;
function normalizeReactionEmoji(raw) {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("emoji required");
	const customMatch = trimmed.match(/^<a?:([^:>]+):(\d+)>$/);
	const identifier = customMatch ? `${customMatch[1]}:${customMatch[2]}` : trimmed.replace(/[\uFE0E\uFE0F]/g, "");
	return encodeURIComponent(identifier);
}
/**
* Parse and resolve Discord recipient, including username lookup.
* This enables sending DMs by username (e.g., "john.doe") by querying
* the Discord directory to resolve usernames to user IDs.
*
* @param raw - The recipient string (username, ID, or known format)
* @param accountId - Discord account ID to use for directory lookup
* @returns Parsed DiscordRecipient with resolved user ID if applicable
*/
async function parseAndResolveRecipient(raw, accountId, cfg) {
	const resolvedCfg = cfg ?? loadConfig();
	const accountInfo = resolveDiscordAccount({
		cfg: resolvedCfg,
		accountId
	});
	const trimmed = raw.trim();
	const parseOptions = { ambiguousMessage: `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.` };
	const resolved = await resolveDiscordTarget(raw, {
		cfg: resolvedCfg,
		accountId: accountInfo.accountId
	}, parseOptions);
	if (resolved) return {
		kind: resolved.kind,
		id: resolved.id
	};
	const parsed = parseDiscordTarget(raw, parseOptions);
	if (!parsed) throw new Error("Recipient is required for Discord sends");
	return {
		kind: parsed.kind,
		id: parsed.id
	};
}
function normalizeStickerIds(raw) {
	const ids = raw.map((entry) => entry.trim()).filter(Boolean);
	if (ids.length === 0) throw new Error("At least one sticker id is required");
	if (ids.length > DISCORD_MAX_STICKERS) throw new Error("Discord supports up to 3 stickers per message");
	return ids;
}
function normalizeEmojiName(raw, label) {
	const name = raw.trim();
	if (!name) throw new Error(`${label} is required`);
	return name;
}
function normalizeDiscordPollInput(input) {
	const poll = normalizePollInput(input, { maxOptions: DISCORD_POLL_MAX_ANSWERS });
	const duration = normalizePollDurationHours(poll.durationHours, {
		defaultHours: 24,
		maxHours: DISCORD_POLL_MAX_DURATION_HOURS
	});
	return {
		question: { text: poll.question },
		answers: poll.options.map((answer) => ({ poll_media: { text: answer } })),
		duration,
		allow_multiselect: poll.maxSelections > 1,
		layout_type: PollLayoutType.Default
	};
}
function getDiscordErrorCode(err) {
	if (!err || typeof err !== "object") return;
	const candidate = "code" in err && err.code !== void 0 ? err.code : "rawError" in err && err.rawError && typeof err.rawError === "object" ? err.rawError.code : void 0;
	if (typeof candidate === "number") return candidate;
	if (typeof candidate === "string" && /^\d+$/.test(candidate)) return Number(candidate);
}
async function buildDiscordSendError(err, ctx) {
	if (err instanceof DiscordSendError) return err;
	const code = getDiscordErrorCode(err);
	if (code === DISCORD_CANNOT_DM) return new DiscordSendError("discord dm failed: user blocks dms or privacy settings disallow it", { kind: "dm-blocked" });
	if (code !== DISCORD_MISSING_PERMISSIONS) return err;
	let missing = [];
	try {
		const permissions = await fetchChannelPermissionsDiscord(ctx.channelId, {
			rest: ctx.rest,
			token: ctx.token
		});
		const current = new Set(permissions.permissions);
		const required = ["ViewChannel", "SendMessages"];
		if (isThreadChannelType(permissions.channelType)) required.push("SendMessagesInThreads");
		if (ctx.hasMedia) required.push("AttachFiles");
		missing = required.filter((permission) => !current.has(permission));
	} catch {}
	return new DiscordSendError(`${missing.length ? `missing permissions in channel ${ctx.channelId}: ${missing.join(", ")}` : `missing permissions in channel ${ctx.channelId}`}. bot might be muted or blocked by role/channel overrides`, {
		kind: "missing-permissions",
		channelId: ctx.channelId,
		missingPermissions: missing
	});
}
async function resolveChannelId(rest, recipient, request) {
	if (recipient.kind === "channel") return { channelId: recipient.id };
	const dmChannel = await request(() => rest.post(Routes.userChannels(), { body: { recipient_id: recipient.id } }), "dm-channel");
	if (!dmChannel?.id) throw new Error("Failed to create Discord DM channel");
	return {
		channelId: dmChannel.id,
		dm: true
	};
}
async function resolveDiscordChannelType(rest, channelId) {
	try {
		return (await rest.get(Routes.channel(channelId)))?.type;
	} catch {
		return;
	}
}
const SUPPRESS_NOTIFICATIONS_FLAG$1 = 4096;
function buildDiscordTextChunks(text, opts = {}) {
	if (!text) return [];
	const chunks = chunkDiscordTextWithMode(text, {
		maxChars: opts.maxChars ?? DISCORD_TEXT_LIMIT,
		maxLines: opts.maxLinesPerMessage,
		chunkMode: opts.chunkMode
	});
	if (!chunks.length && text) chunks.push(text);
	return chunks;
}
function hasV2Components(components) {
	return Boolean(components?.some((component) => "isV2" in component && component.isV2));
}
function resolveDiscordSendComponents(params) {
	if (!params.components || !params.isFirst) return;
	return typeof params.components === "function" ? params.components(params.text) : params.components;
}
function normalizeDiscordEmbeds(embeds) {
	if (!embeds?.length) return;
	return embeds.map((embed) => embed instanceof Embed ? embed : new Embed(embed));
}
function resolveDiscordSendEmbeds(params) {
	if (!params.embeds || !params.isFirst) return;
	return normalizeDiscordEmbeds(params.embeds);
}
function buildDiscordMessagePayload(params) {
	const payload = {};
	const hasV2 = hasV2Components(params.components);
	const trimmed = params.text.trim();
	if (!hasV2 && trimmed) payload.content = params.text;
	if (params.components?.length) payload.components = params.components;
	if (!hasV2 && params.embeds?.length) payload.embeds = params.embeds;
	if (params.flags !== void 0) payload.flags = params.flags;
	if (params.files?.length) payload.files = params.files;
	return payload;
}
function stripUndefinedFields(value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0));
}
function toDiscordFileBlob(data) {
	if (data instanceof Blob) return data;
	const arrayBuffer = new ArrayBuffer(data.byteLength);
	new Uint8Array(arrayBuffer).set(data);
	return new Blob([arrayBuffer]);
}
async function sendDiscordText(rest, channelId, text, replyTo, request, maxLinesPerMessage, components, embeds, chunkMode, silent) {
	if (!text.trim()) throw new Error("Message must be non-empty for Discord sends");
	const messageReference = replyTo ? {
		message_id: replyTo,
		fail_if_not_exists: false
	} : void 0;
	const flags = silent ? SUPPRESS_NOTIFICATIONS_FLAG$1 : void 0;
	const chunks = buildDiscordTextChunks(text, {
		maxLinesPerMessage,
		chunkMode
	});
	const sendChunk = async (chunk, isFirst) => {
		const body = stripUndefinedFields({
			...serializePayload(buildDiscordMessagePayload({
				text: chunk,
				components: resolveDiscordSendComponents({
					components,
					text: chunk,
					isFirst
				}),
				embeds: resolveDiscordSendEmbeds({
					embeds,
					isFirst
				}),
				flags
			})),
			...messageReference ? { message_reference: messageReference } : {}
		});
		return await request(() => rest.post(Routes.channelMessages(channelId), { body }), "text");
	};
	if (chunks.length === 1) return await sendChunk(chunks[0], true);
	let last = null;
	for (const [index, chunk] of chunks.entries()) last = await sendChunk(chunk, index === 0);
	if (!last) throw new Error("Discord send failed (empty chunk result)");
	return last;
}
async function sendDiscordMedia(rest, channelId, text, mediaUrl, mediaLocalRoots, replyTo, request, maxLinesPerMessage, components, embeds, chunkMode, silent) {
	const media = await loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions({ mediaLocalRoots }));
	const chunks = text ? buildDiscordTextChunks(text, {
		maxLinesPerMessage,
		chunkMode
	}) : [];
	const caption = chunks[0] ?? "";
	const messageReference = replyTo ? {
		message_id: replyTo,
		fail_if_not_exists: false
	} : void 0;
	const flags = silent ? SUPPRESS_NOTIFICATIONS_FLAG$1 : void 0;
	const fileData = toDiscordFileBlob(media.buffer);
	const payload = buildDiscordMessagePayload({
		text: caption,
		components: resolveDiscordSendComponents({
			components,
			text: caption,
			isFirst: true
		}),
		embeds: resolveDiscordSendEmbeds({
			embeds,
			isFirst: true
		}),
		flags,
		files: [{
			data: fileData,
			name: media.fileName ?? "upload"
		}]
	});
	const res = await request(() => rest.post(Routes.channelMessages(channelId), { body: stripUndefinedFields({
		...serializePayload(payload),
		...messageReference ? { message_reference: messageReference } : {}
	}) }), "media");
	for (const chunk of chunks.slice(1)) {
		if (!chunk.trim()) continue;
		await sendDiscordText(rest, channelId, chunk, replyTo, request, maxLinesPerMessage, void 0, void 0, chunkMode, silent);
	}
	return res;
}
function buildReactionIdentifier(emoji) {
	if (emoji.id && emoji.name) return `${emoji.name}:${emoji.id}`;
	return emoji.name ?? "";
}
function formatReactionEmoji(emoji) {
	return buildReactionIdentifier(emoji);
}

//#endregion
//#region src/discord/send.channels.ts
async function createChannelDiscord(payload, opts = {}) {
	const rest = resolveDiscordRest(opts);
	const body = { name: payload.name };
	if (payload.type !== void 0) body.type = payload.type;
	if (payload.parentId) body.parent_id = payload.parentId;
	if (payload.topic) body.topic = payload.topic;
	if (payload.position !== void 0) body.position = payload.position;
	if (payload.nsfw !== void 0) body.nsfw = payload.nsfw;
	return await rest.post(Routes.guildChannels(payload.guildId), { body });
}
async function editChannelDiscord(payload, opts = {}) {
	const rest = resolveDiscordRest(opts);
	const body = {};
	if (payload.name !== void 0) body.name = payload.name;
	if (payload.topic !== void 0) body.topic = payload.topic;
	if (payload.position !== void 0) body.position = payload.position;
	if (payload.parentId !== void 0) body.parent_id = payload.parentId;
	if (payload.nsfw !== void 0) body.nsfw = payload.nsfw;
	if (payload.rateLimitPerUser !== void 0) body.rate_limit_per_user = payload.rateLimitPerUser;
	if (payload.archived !== void 0) body.archived = payload.archived;
	if (payload.locked !== void 0) body.locked = payload.locked;
	if (payload.autoArchiveDuration !== void 0) body.auto_archive_duration = payload.autoArchiveDuration;
	if (payload.availableTags !== void 0) body.available_tags = payload.availableTags.map((t) => ({
		...t.id !== void 0 && { id: t.id },
		name: t.name,
		...t.moderated !== void 0 && { moderated: t.moderated },
		...t.emoji_id !== void 0 && { emoji_id: t.emoji_id },
		...t.emoji_name !== void 0 && { emoji_name: t.emoji_name }
	}));
	return await rest.patch(Routes.channel(payload.channelId), { body });
}
async function deleteChannelDiscord(channelId, opts = {}) {
	await resolveDiscordRest(opts).delete(Routes.channel(channelId));
	return {
		ok: true,
		channelId
	};
}
async function moveChannelDiscord(payload, opts = {}) {
	const rest = resolveDiscordRest(opts);
	const body = [{
		id: payload.channelId,
		...payload.parentId !== void 0 && { parent_id: payload.parentId },
		...payload.position !== void 0 && { position: payload.position }
	}];
	await rest.patch(Routes.guildChannels(payload.guildId), { body });
	return { ok: true };
}
async function setChannelPermissionDiscord(payload, opts = {}) {
	const rest = resolveDiscordRest(opts);
	const body = { type: payload.targetType };
	if (payload.allow !== void 0) body.allow = payload.allow;
	if (payload.deny !== void 0) body.deny = payload.deny;
	await rest.put(`/channels/${payload.channelId}/permissions/${payload.targetId}`, { body });
	return { ok: true };
}
async function removeChannelPermissionDiscord(channelId, targetId, opts = {}) {
	await resolveDiscordRest(opts).delete(`/channels/${channelId}/permissions/${targetId}`);
	return { ok: true };
}

//#endregion
//#region src/discord/send.emojis-stickers.ts
async function listGuildEmojisDiscord(guildId, opts = {}) {
	return await resolveDiscordRest(opts).get(Routes.guildEmojis(guildId));
}
async function uploadEmojiDiscord(payload, opts = {}) {
	const rest = resolveDiscordRest(opts);
	const media = await loadWebMediaRaw(payload.mediaUrl, DISCORD_MAX_EMOJI_BYTES);
	const contentType = media.contentType?.toLowerCase();
	if (!contentType || ![
		"image/png",
		"image/jpeg",
		"image/jpg",
		"image/gif"
	].includes(contentType)) throw new Error("Discord emoji uploads require a PNG, JPG, or GIF image");
	const image = `data:${contentType};base64,${media.buffer.toString("base64")}`;
	const roleIds = (payload.roleIds ?? []).map((id) => id.trim()).filter(Boolean);
	return await rest.post(Routes.guildEmojis(payload.guildId), { body: {
		name: normalizeEmojiName(payload.name, "Emoji name"),
		image,
		roles: roleIds.length ? roleIds : void 0
	} });
}
async function uploadStickerDiscord(payload, opts = {}) {
	const rest = resolveDiscordRest(opts);
	const media = await loadWebMediaRaw(payload.mediaUrl, DISCORD_MAX_STICKER_BYTES);
	const contentType = media.contentType?.toLowerCase();
	if (!contentType || ![
		"image/png",
		"image/apng",
		"application/json"
	].includes(contentType)) throw new Error("Discord sticker uploads require a PNG, APNG, or Lottie JSON file");
	return await rest.post(Routes.guildStickers(payload.guildId), { body: {
		name: normalizeEmojiName(payload.name, "Sticker name"),
		description: normalizeEmojiName(payload.description, "Sticker description"),
		tags: normalizeEmojiName(payload.tags, "Sticker tags"),
		files: [{
			data: media.buffer,
			name: media.fileName ?? "sticker",
			contentType
		}]
	} });
}

//#endregion
//#region src/discord/send.guild.ts
async function fetchMemberInfoDiscord(guildId, userId, opts = {}) {
	return await resolveDiscordRest(opts).get(Routes.guildMember(guildId, userId));
}
async function fetchRoleInfoDiscord(guildId, opts = {}) {
	return await resolveDiscordRest(opts).get(Routes.guildRoles(guildId));
}
async function addRoleDiscord(payload, opts = {}) {
	await resolveDiscordRest(opts).put(Routes.guildMemberRole(payload.guildId, payload.userId, payload.roleId));
	return { ok: true };
}
async function removeRoleDiscord(payload, opts = {}) {
	await resolveDiscordRest(opts).delete(Routes.guildMemberRole(payload.guildId, payload.userId, payload.roleId));
	return { ok: true };
}
async function fetchChannelInfoDiscord(channelId, opts = {}) {
	return await resolveDiscordRest(opts).get(Routes.channel(channelId));
}
async function listGuildChannelsDiscord(guildId, opts = {}) {
	return await resolveDiscordRest(opts).get(Routes.guildChannels(guildId));
}
async function fetchVoiceStatusDiscord(guildId, userId, opts = {}) {
	return await resolveDiscordRest(opts).get(Routes.guildVoiceState(guildId, userId));
}
async function listScheduledEventsDiscord(guildId, opts = {}) {
	return await resolveDiscordRest(opts).get(Routes.guildScheduledEvents(guildId));
}
async function createScheduledEventDiscord(guildId, payload, opts = {}) {
	return await resolveDiscordRest(opts).post(Routes.guildScheduledEvents(guildId), { body: payload });
}
async function timeoutMemberDiscord(payload, opts = {}) {
	const rest = resolveDiscordRest(opts);
	let until = payload.until;
	if (!until && payload.durationMinutes) {
		const ms = payload.durationMinutes * 60 * 1e3;
		until = new Date(Date.now() + ms).toISOString();
	}
	return await rest.patch(Routes.guildMember(payload.guildId, payload.userId), {
		body: { communication_disabled_until: until ?? null },
		headers: payload.reason ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) } : void 0
	});
}
async function kickMemberDiscord(payload, opts = {}) {
	await resolveDiscordRest(opts).delete(Routes.guildMember(payload.guildId, payload.userId), { headers: payload.reason ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) } : void 0 });
	return { ok: true };
}
async function banMemberDiscord(payload, opts = {}) {
	const rest = resolveDiscordRest(opts);
	const deleteMessageDays = typeof payload.deleteMessageDays === "number" && Number.isFinite(payload.deleteMessageDays) ? Math.min(Math.max(Math.floor(payload.deleteMessageDays), 0), 7) : void 0;
	await rest.put(Routes.guildBan(payload.guildId, payload.userId), {
		body: deleteMessageDays !== void 0 ? { delete_message_days: deleteMessageDays } : void 0,
		headers: payload.reason ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) } : void 0
	});
	return { ok: true };
}

//#endregion
//#region src/discord/send.messages.ts
async function readMessagesDiscord(channelId, query = {}, opts = {}) {
	const rest = resolveDiscordRest(opts);
	const limit = typeof query.limit === "number" && Number.isFinite(query.limit) ? Math.min(Math.max(Math.floor(query.limit), 1), 100) : void 0;
	const params = {};
	if (limit) params.limit = limit;
	if (query.before) params.before = query.before;
	if (query.after) params.after = query.after;
	if (query.around) params.around = query.around;
	return await rest.get(Routes.channelMessages(channelId), params);
}
async function fetchMessageDiscord(channelId, messageId, opts = {}) {
	return await resolveDiscordRest(opts).get(Routes.channelMessage(channelId, messageId));
}
async function editMessageDiscord(channelId, messageId, payload, opts = {}) {
	return await resolveDiscordRest(opts).patch(Routes.channelMessage(channelId, messageId), { body: { content: payload.content } });
}
async function deleteMessageDiscord(channelId, messageId, opts = {}) {
	await resolveDiscordRest(opts).delete(Routes.channelMessage(channelId, messageId));
	return { ok: true };
}
async function pinMessageDiscord(channelId, messageId, opts = {}) {
	await resolveDiscordRest(opts).put(Routes.channelPin(channelId, messageId));
	return { ok: true };
}
async function unpinMessageDiscord(channelId, messageId, opts = {}) {
	await resolveDiscordRest(opts).delete(Routes.channelPin(channelId, messageId));
	return { ok: true };
}
async function listPinsDiscord(channelId, opts = {}) {
	return await resolveDiscordRest(opts).get(Routes.channelPins(channelId));
}
async function createThreadDiscord(channelId, payload, opts = {}) {
	const rest = resolveDiscordRest(opts);
	const body = { name: payload.name };
	if (payload.autoArchiveMinutes) body.auto_archive_duration = payload.autoArchiveMinutes;
	if (!payload.messageId && payload.type !== void 0) body.type = payload.type;
	let channelType;
	if (!payload.messageId) try {
		channelType = (await rest.get(Routes.channel(channelId)))?.type;
	} catch {
		channelType = void 0;
	}
	const isForumLike = channelType === ChannelType.GuildForum || channelType === ChannelType.GuildMedia;
	if (isForumLike) {
		body.message = { content: payload.content?.trim() ? payload.content : payload.name };
		if (payload.appliedTags?.length) body.applied_tags = payload.appliedTags;
	}
	if (!payload.messageId && !isForumLike && body.type === void 0) body.type = ChannelType.PublicThread;
	const route = payload.messageId ? Routes.threads(channelId, payload.messageId) : Routes.threads(channelId);
	const thread = await rest.post(route, { body });
	if (!isForumLike && payload.content?.trim()) await rest.post(Routes.channelMessages(thread.id), { body: { content: payload.content } });
	return thread;
}
async function listThreadsDiscord(payload, opts = {}) {
	const rest = resolveDiscordRest(opts);
	if (payload.includeArchived) {
		if (!payload.channelId) throw new Error("channelId required to list archived threads");
		const params = {};
		if (payload.before) params.before = payload.before;
		if (payload.limit) params.limit = payload.limit;
		return await rest.get(Routes.channelThreads(payload.channelId, "public"), params);
	}
	return await rest.get(Routes.guildActiveThreads(payload.guildId));
}
async function searchMessagesDiscord(query, opts = {}) {
	const rest = resolveDiscordRest(opts);
	const params = new URLSearchParams();
	params.set("content", query.content);
	if (query.channelIds?.length) for (const channelId of query.channelIds) params.append("channel_id", channelId);
	if (query.authorIds?.length) for (const authorId of query.authorIds) params.append("author_id", authorId);
	if (query.limit) {
		const limit = Math.min(Math.max(Math.floor(query.limit), 1), 25);
		params.set("limit", String(limit));
	}
	return await rest.get(`/guilds/${query.guildId}/messages/search?${params.toString()}`);
}

//#endregion
//#region src/markdown/tables.ts
const MARKDOWN_STYLE_MARKERS = {
	bold: {
		open: "**",
		close: "**"
	},
	italic: {
		open: "_",
		close: "_"
	},
	strikethrough: {
		open: "~~",
		close: "~~"
	},
	code: {
		open: "`",
		close: "`"
	},
	code_block: {
		open: "```\n",
		close: "```"
	}
};
function convertMarkdownTables(markdown, mode) {
	if (!markdown || mode === "off") return markdown;
	const { ir, hasTables } = markdownToIRWithMeta(markdown, {
		linkify: false,
		autolink: false,
		headingStyle: "none",
		blockquotePrefix: "",
		tableMode: mode
	});
	if (!hasTables) return markdown;
	return renderMarkdownWithMarkers(ir, {
		styleMarkers: MARKDOWN_STYLE_MARKERS,
		escapeText: (text) => text,
		buildLink: (link, text) => {
			const href = link.href.trim();
			if (!href) return null;
			if (!text.slice(link.start, link.end)) return null;
			return {
				start: link.start,
				end: link.end,
				open: "[",
				close: `](${href})`
			};
		}
	});
}

//#endregion
//#region src/media/temp-files.ts
async function unlinkIfExists(filePath) {
	if (!filePath) return;
	try {
		await fs.unlink(filePath);
	} catch {}
}

//#endregion
//#region src/discord/mentions.ts
const MARKDOWN_CODE_SEGMENT_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const MENTION_CANDIDATE_PATTERN = /(^|[\s([{"'.,;:!?])@([a-z0-9_.-]{2,32}(?:#[0-9]{4})?)/gi;
const DISCORD_RESERVED_MENTIONS = new Set(["everyone", "here"]);
function normalizeSnowflake(value) {
	const text = String(value ?? "").trim();
	if (!/^\d+$/.test(text)) return null;
	return text;
}
function formatMention(params) {
	const userId = params.userId == null ? null : normalizeSnowflake(params.userId);
	const roleId = params.roleId == null ? null : normalizeSnowflake(params.roleId);
	const channelId = params.channelId == null ? null : normalizeSnowflake(params.channelId);
	const values = [
		userId ? {
			kind: "user",
			id: userId
		} : null,
		roleId ? {
			kind: "role",
			id: roleId
		} : null,
		channelId ? {
			kind: "channel",
			id: channelId
		} : null
	].filter((entry) => Boolean(entry));
	if (values.length !== 1) throw new Error("formatMention requires exactly one of userId, roleId, or channelId");
	const target = values[0];
	if (target.kind === "user") return `<@${target.id}>`;
	if (target.kind === "role") return `<@&${target.id}>`;
	return `<#${target.id}>`;
}
function rewritePlainTextMentions(text, accountId) {
	if (!text.includes("@")) return text;
	return text.replace(MENTION_CANDIDATE_PATTERN, (match, prefix, rawHandle) => {
		const handle = String(rawHandle ?? "").trim();
		if (!handle) return match;
		const lookup = handle.toLowerCase();
		if (DISCORD_RESERVED_MENTIONS.has(lookup)) return match;
		const userId = resolveDiscordDirectoryUserId({
			accountId,
			handle
		});
		if (!userId) return match;
		return `${String(prefix ?? "")}${formatMention({ userId })}`;
	});
}
function rewriteDiscordKnownMentions(text, params) {
	if (!text.includes("@")) return text;
	let rewritten = "";
	let offset = 0;
	MARKDOWN_CODE_SEGMENT_PATTERN.lastIndex = 0;
	for (const match of text.matchAll(MARKDOWN_CODE_SEGMENT_PATTERN)) {
		const matchIndex = match.index ?? 0;
		rewritten += rewritePlainTextMentions(text.slice(offset, matchIndex), params.accountId);
		rewritten += match[0];
		offset = matchIndex + match[0].length;
	}
	rewritten += rewritePlainTextMentions(text.slice(offset), params.accountId);
	return rewritten;
}

//#endregion
//#region src/media/ffmpeg-limits.ts
const MEDIA_FFMPEG_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const MEDIA_FFPROBE_TIMEOUT_MS = 1e4;
const MEDIA_FFMPEG_TIMEOUT_MS = 45e3;
const MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS = 1200;

//#endregion
//#region src/media/ffmpeg-exec.ts
const execFileAsync = promisify(execFile);
function resolveExecOptions(defaultTimeoutMs, options) {
	return {
		timeout: options?.timeoutMs ?? defaultTimeoutMs,
		maxBuffer: options?.maxBufferBytes ?? MEDIA_FFMPEG_MAX_BUFFER_BYTES
	};
}
async function runFfprobe(args, options) {
	const { stdout } = await execFileAsync("ffprobe", args, resolveExecOptions(MEDIA_FFPROBE_TIMEOUT_MS, options));
	return stdout.toString();
}
async function runFfmpeg(args, options) {
	const { stdout } = await execFileAsync("ffmpeg", args, resolveExecOptions(MEDIA_FFMPEG_TIMEOUT_MS, options));
	return stdout.toString();
}
function parseFfprobeCsvFields(stdout, maxFields) {
	return stdout.trim().toLowerCase().split(/[,\r\n]+/, maxFields).map((field) => field.trim());
}
function parseFfprobeCodecAndSampleRate(stdout) {
	const [codecRaw, sampleRateRaw] = parseFfprobeCsvFields(stdout, 2);
	const codec = codecRaw ? codecRaw : null;
	const sampleRate = sampleRateRaw ? Number.parseInt(sampleRateRaw, 10) : NaN;
	return {
		codec,
		sampleRateHz: Number.isFinite(sampleRate) ? sampleRate : null
	};
}

//#endregion
//#region src/discord/voice-message.ts
/**
* Discord Voice Message Support
*
* Implements sending voice messages via Discord's API.
* Voice messages require:
* - OGG/Opus format audio
* - Waveform data (base64 encoded, up to 256 samples, 0-255 values)
* - Duration in seconds
* - Message flag 8192 (IS_VOICE_MESSAGE)
* - No other content (text, embeds, etc.)
*/
const DISCORD_VOICE_MESSAGE_FLAG = 8192;
const SUPPRESS_NOTIFICATIONS_FLAG = 4096;
const WAVEFORM_SAMPLES = 256;
const DISCORD_OPUS_SAMPLE_RATE_HZ = 48e3;
/**
* Get audio duration using ffprobe
*/
async function getAudioDuration(filePath) {
	try {
		const stdout = await runFfprobe([
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"csv=p=0",
			filePath
		]);
		const duration = parseFloat(stdout.trim());
		if (isNaN(duration)) throw new Error("Could not parse duration");
		return Math.round(duration * 100) / 100;
	} catch (err) {
		const errMessage = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to get audio duration: ${errMessage}`, { cause: err });
	}
}
/**
* Generate waveform data from audio file using ffmpeg
* Returns base64 encoded byte array of amplitude samples (0-255)
*/
async function generateWaveform(filePath) {
	try {
		return await generateWaveformFromPcm(filePath);
	} catch {
		return generatePlaceholderWaveform();
	}
}
/**
* Generate waveform by extracting raw PCM data and sampling amplitudes
*/
async function generateWaveformFromPcm(filePath) {
	const tempDir = resolvePreferredOpenClawTmpDir();
	const tempPcm = path.join(tempDir, `waveform-${crypto.randomUUID()}.raw`);
	try {
		await runFfmpeg([
			"-y",
			"-i",
			filePath,
			"-vn",
			"-sn",
			"-dn",
			"-t",
			String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
			"-f",
			"s16le",
			"-acodec",
			"pcm_s16le",
			"-ac",
			"1",
			"-ar",
			"8000",
			tempPcm
		]);
		const pcmData = await fs.readFile(tempPcm);
		const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);
		const step = Math.max(1, Math.floor(samples.length / WAVEFORM_SAMPLES));
		const waveform = [];
		for (let i = 0; i < WAVEFORM_SAMPLES && i * step < samples.length; i++) {
			let sum = 0;
			let count = 0;
			for (let j = 0; j < step && i * step + j < samples.length; j++) {
				sum += Math.abs(samples[i * step + j]);
				count++;
			}
			const avg = count > 0 ? sum / count : 0;
			const normalized = Math.min(255, Math.round(avg / 32767 * 255));
			waveform.push(normalized);
		}
		while (waveform.length < WAVEFORM_SAMPLES) waveform.push(0);
		return Buffer.from(waveform).toString("base64");
	} finally {
		await unlinkIfExists(tempPcm);
	}
}
/**
* Generate a placeholder waveform (for when audio processing fails)
*/
function generatePlaceholderWaveform() {
	const waveform = [];
	for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
		const value = Math.round(128 + 64 * Math.sin(i / WAVEFORM_SAMPLES * Math.PI * 8));
		waveform.push(Math.min(255, Math.max(0, value)));
	}
	return Buffer.from(waveform).toString("base64");
}
/**
* Convert audio file to OGG/Opus format if needed
* Returns path to the OGG file (may be same as input if already OGG/Opus)
*/
async function ensureOggOpus(filePath) {
	const trimmed = filePath.trim();
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) throw new Error(`Voice message conversion requires a local file path; received a URL/protocol source: ${trimmed}`);
	if (path.extname(filePath).toLowerCase() === ".ogg") try {
		const { codec, sampleRateHz } = parseFfprobeCodecAndSampleRate(await runFfprobe([
			"-v",
			"error",
			"-select_streams",
			"a:0",
			"-show_entries",
			"stream=codec_name,sample_rate",
			"-of",
			"csv=p=0",
			filePath
		]));
		if (codec === "opus" && sampleRateHz === DISCORD_OPUS_SAMPLE_RATE_HZ) return {
			path: filePath,
			cleanup: false
		};
	} catch {}
	const tempDir = resolvePreferredOpenClawTmpDir();
	const outputPath = path.join(tempDir, `voice-${crypto.randomUUID()}.ogg`);
	await runFfmpeg([
		"-y",
		"-i",
		filePath,
		"-vn",
		"-sn",
		"-dn",
		"-t",
		String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
		"-ar",
		String(DISCORD_OPUS_SAMPLE_RATE_HZ),
		"-c:a",
		"libopus",
		"-b:a",
		"64k",
		outputPath
	]);
	return {
		path: outputPath,
		cleanup: true
	};
}
/**
* Get voice message metadata (duration and waveform)
*/
async function getVoiceMessageMetadata(filePath) {
	const [durationSecs, waveform] = await Promise.all([getAudioDuration(filePath), generateWaveform(filePath)]);
	return {
		durationSecs,
		waveform
	};
}
/**
* Send a voice message to Discord
*
* This follows Discord's voice message protocol:
* 1. Request upload URL from Discord
* 2. Upload the OGG file to the provided URL
* 3. Send the message with flag 8192 and attachment metadata
*/
async function sendDiscordVoiceMessage(rest, channelId, audioBuffer, metadata, replyTo, request, silent, token) {
	const filename = "voice-message.ogg";
	const fileSize = audioBuffer.byteLength;
	const botToken = token;
	if (!botToken) throw new Error("Discord bot token is required for voice message upload");
	const uploadUrlResponse = await request(async () => {
		const url = `${rest.options?.baseUrl ?? "https://discord.com/api"}/channels/${channelId}/attachments`;
		const res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bot ${botToken}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({ files: [{
				filename,
				file_size: fileSize,
				id: "0"
			}] })
		});
		if (!res.ok) {
			if (res.status === 429) {
				const retryData = await res.json().catch(() => ({}));
				throw new RateLimitError(res, {
					message: retryData.message ?? "You are being rate limited.",
					retry_after: retryData.retry_after ?? 1,
					global: retryData.global ?? false
				});
			}
			const errorBody = await res.json().catch(() => null);
			const err = /* @__PURE__ */ new Error(`Upload URL request failed: ${res.status} ${errorBody?.message ?? ""}`);
			if (errorBody?.code !== void 0) err.code = errorBody.code;
			throw err;
		}
		return await res.json();
	}, "voice-upload-url");
	if (!uploadUrlResponse.attachments?.[0]) throw new Error("Failed to get upload URL for voice message");
	const { upload_url, upload_filename } = uploadUrlResponse.attachments[0];
	const uploadResponse = await fetch(upload_url, {
		method: "PUT",
		headers: { "Content-Type": "audio/ogg" },
		body: new Uint8Array(audioBuffer)
	});
	if (!uploadResponse.ok) throw new Error(`Failed to upload voice message: ${uploadResponse.status}`);
	const messagePayload = {
		flags: silent ? DISCORD_VOICE_MESSAGE_FLAG | SUPPRESS_NOTIFICATIONS_FLAG : DISCORD_VOICE_MESSAGE_FLAG,
		attachments: [{
			id: "0",
			filename,
			uploaded_filename: upload_filename,
			duration_secs: metadata.durationSecs,
			waveform: metadata.waveform
		}]
	};
	if (replyTo) messagePayload.message_reference = {
		message_id: replyTo,
		fail_if_not_exists: false
	};
	return await request(() => rest.post(`/channels/${channelId}/messages`, { body: messagePayload }), "voice-message");
}

//#endregion
//#region src/discord/send.outbound.ts
async function sendDiscordThreadTextChunks(params) {
	for (const chunk of params.chunks) await sendDiscordText(params.rest, params.threadId, chunk, void 0, params.request, params.maxLinesPerMessage, void 0, void 0, params.chunkMode, params.silent);
}
/** Discord thread names are capped at 100 characters. */
const DISCORD_THREAD_NAME_LIMIT = 100;
/** Derive a thread title from the first non-empty line of the message text. */
function deriveForumThreadName(text) {
	return (text.split("\n").find((l) => l.trim())?.trim() ?? "").slice(0, DISCORD_THREAD_NAME_LIMIT) || (/* @__PURE__ */ new Date()).toISOString().slice(0, 16);
}
/** Forum/Media channels cannot receive regular messages; detect them here. */
function isForumLikeType(channelType) {
	return channelType === ChannelType.GuildForum || channelType === ChannelType.GuildMedia;
}
function toDiscordSendResult(result, fallbackChannelId) {
	return {
		messageId: result.id ? String(result.id) : "unknown",
		channelId: String(result.channel_id ?? fallbackChannelId)
	};
}
async function resolveDiscordSendTarget(to, opts) {
	const cfg = opts.cfg ?? loadConfig();
	const { rest, request } = createDiscordClient(opts, cfg);
	const { channelId } = await resolveChannelId(rest, await parseAndResolveRecipient(to, opts.accountId, cfg), request);
	return {
		rest,
		request,
		channelId
	};
}
async function sendMessageDiscord(to, text, opts = {}) {
	const cfg = opts.cfg ?? loadConfig();
	const accountInfo = resolveDiscordAccount({
		cfg,
		accountId: opts.accountId
	});
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "discord",
		accountId: accountInfo.accountId
	});
	const chunkMode = resolveChunkMode(cfg, "discord", accountInfo.accountId);
	const textWithTables = convertMarkdownTables(text ?? "", tableMode);
	const textWithMentions = rewriteDiscordKnownMentions(textWithTables, { accountId: accountInfo.accountId });
	const { token, rest, request } = createDiscordClient(opts, cfg);
	const { channelId } = await resolveChannelId(rest, await parseAndResolveRecipient(to, opts.accountId, cfg), request);
	if (isForumLikeType(await resolveDiscordChannelType(rest, channelId))) {
		const threadName = deriveForumThreadName(textWithTables);
		const chunks = buildDiscordTextChunks(textWithMentions, {
			maxLinesPerMessage: accountInfo.config.maxLinesPerMessage,
			chunkMode
		});
		const starterContent = chunks[0]?.trim() ? chunks[0] : threadName;
		const starterPayload = buildDiscordMessagePayload({
			text: starterContent,
			components: resolveDiscordSendComponents({
				components: opts.components,
				text: starterContent,
				isFirst: true
			}),
			embeds: resolveDiscordSendEmbeds({
				embeds: opts.embeds,
				isFirst: true
			}),
			flags: opts.silent ? 4096 : void 0
		});
		let threadRes;
		try {
			threadRes = await request(() => rest.post(Routes.threads(channelId), { body: {
				name: threadName,
				message: stripUndefinedFields(serializePayload(starterPayload))
			} }), "forum-thread");
		} catch (err) {
			throw await buildDiscordSendError(err, {
				channelId,
				rest,
				token,
				hasMedia: Boolean(opts.mediaUrl)
			});
		}
		const threadId = threadRes.id;
		const messageId = threadRes.message?.id ?? threadId;
		const resultChannelId = threadRes.message?.channel_id ?? threadId;
		const remainingChunks = chunks.slice(1);
		try {
			if (opts.mediaUrl) {
				const [mediaCaption, ...afterMediaChunks] = remainingChunks;
				await sendDiscordMedia(rest, threadId, mediaCaption ?? "", opts.mediaUrl, opts.mediaLocalRoots, void 0, request, accountInfo.config.maxLinesPerMessage, void 0, void 0, chunkMode, opts.silent);
				await sendDiscordThreadTextChunks({
					rest,
					threadId,
					chunks: afterMediaChunks,
					request,
					maxLinesPerMessage: accountInfo.config.maxLinesPerMessage,
					chunkMode,
					silent: opts.silent
				});
			} else await sendDiscordThreadTextChunks({
				rest,
				threadId,
				chunks: remainingChunks,
				request,
				maxLinesPerMessage: accountInfo.config.maxLinesPerMessage,
				chunkMode,
				silent: opts.silent
			});
		} catch (err) {
			throw await buildDiscordSendError(err, {
				channelId: threadId,
				rest,
				token,
				hasMedia: Boolean(opts.mediaUrl)
			});
		}
		recordChannelActivity({
			channel: "discord",
			accountId: accountInfo.accountId,
			direction: "outbound"
		});
		return toDiscordSendResult({
			id: messageId,
			channel_id: resultChannelId
		}, channelId);
	}
	let result;
	try {
		if (opts.mediaUrl) result = await sendDiscordMedia(rest, channelId, textWithMentions, opts.mediaUrl, opts.mediaLocalRoots, opts.replyTo, request, accountInfo.config.maxLinesPerMessage, opts.components, opts.embeds, chunkMode, opts.silent);
		else result = await sendDiscordText(rest, channelId, textWithMentions, opts.replyTo, request, accountInfo.config.maxLinesPerMessage, opts.components, opts.embeds, chunkMode, opts.silent);
	} catch (err) {
		throw await buildDiscordSendError(err, {
			channelId,
			rest,
			token,
			hasMedia: Boolean(opts.mediaUrl)
		});
	}
	recordChannelActivity({
		channel: "discord",
		accountId: accountInfo.accountId,
		direction: "outbound"
	});
	return toDiscordSendResult(result, channelId);
}
async function sendStickerDiscord(to, stickerIds, opts = {}) {
	const { rest, request, channelId } = await resolveDiscordSendTarget(to, opts);
	const content = opts.content?.trim();
	const rewrittenContent = content ? rewriteDiscordKnownMentions(content, { accountId: opts.accountId }) : void 0;
	const stickers = normalizeStickerIds(stickerIds);
	return toDiscordSendResult(await request(() => rest.post(Routes.channelMessages(channelId), { body: {
		content: rewrittenContent || void 0,
		sticker_ids: stickers
	} }), "sticker"), channelId);
}
async function sendPollDiscord(to, poll, opts = {}) {
	const { rest, request, channelId } = await resolveDiscordSendTarget(to, opts);
	const content = opts.content?.trim();
	const rewrittenContent = content ? rewriteDiscordKnownMentions(content, { accountId: opts.accountId }) : void 0;
	if (poll.durationSeconds !== void 0) throw new Error("Discord polls do not support durationSeconds; use durationHours");
	const payload = normalizeDiscordPollInput(poll);
	const flags = opts.silent ? SUPPRESS_NOTIFICATIONS_FLAG$1 : void 0;
	return toDiscordSendResult(await request(() => rest.post(Routes.channelMessages(channelId), { body: {
		content: rewrittenContent || void 0,
		poll: payload,
		...flags ? { flags } : {}
	} }), "poll"), channelId);
}
async function materializeVoiceMessageInput(mediaUrl) {
	const media = await loadWebMediaRaw(mediaUrl, maxBytesForKind("audio"));
	const extFromName = media.fileName ? path.extname(media.fileName) : "";
	const extFromMime = media.contentType ? extensionForMime(media.contentType) : "";
	const ext = extFromName || extFromMime || ".bin";
	const tempDir = resolvePreferredOpenClawTmpDir();
	const filePath = path.join(tempDir, `voice-src-${crypto.randomUUID()}${ext}`);
	await fs.writeFile(filePath, media.buffer, { mode: 384 });
	return { filePath };
}
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
async function sendVoiceMessageDiscord(to, audioPath, opts = {}) {
	const { filePath: localInputPath } = await materializeVoiceMessageInput(audioPath);
	let oggPath = null;
	let oggCleanup = false;
	let token;
	let rest;
	let channelId;
	try {
		const cfg = opts.cfg ?? loadConfig();
		const accountInfo = resolveDiscordAccount({
			cfg,
			accountId: opts.accountId
		});
		const client = createDiscordClient(opts, cfg);
		token = client.token;
		rest = client.rest;
		const request = client.request;
		const recipient = await parseAndResolveRecipient(to, opts.accountId, cfg);
		channelId = (await resolveChannelId(rest, recipient, request)).channelId;
		const ogg = await ensureOggOpus(localInputPath);
		oggPath = ogg.path;
		oggCleanup = ogg.cleanup;
		const metadata = await getVoiceMessageMetadata(oggPath);
		const audioBuffer = await fs.readFile(oggPath);
		const result = await sendDiscordVoiceMessage(rest, channelId, audioBuffer, metadata, opts.replyTo, request, opts.silent, token);
		recordChannelActivity({
			channel: "discord",
			accountId: accountInfo.accountId,
			direction: "outbound"
		});
		return toDiscordSendResult(result, channelId);
	} catch (err) {
		if (channelId && rest && token) throw await buildDiscordSendError(err, {
			channelId,
			rest,
			token,
			hasMedia: true
		});
		throw err;
	} finally {
		await unlinkIfExists(oggCleanup ? oggPath : null);
		await unlinkIfExists(localInputPath);
	}
}

//#endregion
//#region src/discord/components-registry.ts
const DEFAULT_COMPONENT_TTL_MS = 1800 * 1e3;
const componentEntries = /* @__PURE__ */ new Map();
const modalEntries = /* @__PURE__ */ new Map();
function normalizeEntryTimestamps(entry, now, ttlMs) {
	const createdAt = entry.createdAt ?? now;
	const expiresAt = entry.expiresAt ?? createdAt + ttlMs;
	return {
		...entry,
		createdAt,
		expiresAt
	};
}
function registerDiscordComponentEntries(params) {
	const now = Date.now();
	const ttlMs = params.ttlMs ?? DEFAULT_COMPONENT_TTL_MS;
	for (const entry of params.entries) {
		const normalized = normalizeEntryTimestamps({
			...entry,
			messageId: params.messageId ?? entry.messageId
		}, now, ttlMs);
		componentEntries.set(entry.id, normalized);
	}
	for (const modal of params.modals) {
		const normalized = normalizeEntryTimestamps({
			...modal,
			messageId: params.messageId ?? modal.messageId
		}, now, ttlMs);
		modalEntries.set(modal.id, normalized);
	}
}

//#endregion
//#region src/discord/components.ts
const DISCORD_COMPONENT_CUSTOM_ID_KEY = "occomp";
const DISCORD_COMPONENT_ATTACHMENT_PREFIX = "attachment://";
const BLOCK_ALIASES = new Map([["row", "actions"], ["action-row", "actions"]]);
function createShortId(prefix) {
	return `${prefix}${crypto.randomBytes(6).toString("base64url")}`;
}
function requireObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value;
}
function readString(value, label, opts) {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const trimmed = value.trim();
	if (!opts?.allowEmpty && !trimmed) throw new Error(`${label} cannot be empty`);
	return opts?.allowEmpty ? value : trimmed;
}
function readOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function readOptionalStringArray(value, label) {
	if (value === void 0) return;
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	if (value.length === 0) return;
	return value.map((entry, index) => readString(entry, `${label}[${index}]`));
}
function readOptionalNumber(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return value;
}
function normalizeModalFieldName(value, index) {
	const trimmed = value?.trim();
	if (trimmed) return trimmed;
	return `field_${index + 1}`;
}
function normalizeAttachmentRef(value, label) {
	const trimmed = value.trim();
	if (!trimmed.startsWith(DISCORD_COMPONENT_ATTACHMENT_PREFIX)) throw new Error(`${label} must start with "${DISCORD_COMPONENT_ATTACHMENT_PREFIX}"`);
	const attachmentName = trimmed.slice(13).trim();
	if (!attachmentName) throw new Error(`${label} must include an attachment filename`);
	return `${DISCORD_COMPONENT_ATTACHMENT_PREFIX}${attachmentName}`;
}
function resolveDiscordComponentAttachmentName(value) {
	const trimmed = value.trim();
	if (!trimmed.startsWith(DISCORD_COMPONENT_ATTACHMENT_PREFIX)) throw new Error(`Attachment reference must start with "${DISCORD_COMPONENT_ATTACHMENT_PREFIX}"`);
	const attachmentName = trimmed.slice(13).trim();
	if (!attachmentName) throw new Error("Attachment reference must include a filename");
	return attachmentName;
}
function mapButtonStyle(style) {
	switch ((style ?? "primary").toLowerCase()) {
		case "secondary": return ButtonStyle.Secondary;
		case "success": return ButtonStyle.Success;
		case "danger": return ButtonStyle.Danger;
		case "link": return ButtonStyle.Link;
		default: return ButtonStyle.Primary;
	}
}
function normalizeBlockType(raw) {
	const lowered = raw.trim().toLowerCase();
	return BLOCK_ALIASES.get(lowered) ?? lowered;
}
function parseSelectOptions(raw, label) {
	if (raw === void 0) return;
	if (!Array.isArray(raw)) throw new Error(`${label} must be an array`);
	return raw.map((entry, index) => {
		const obj = requireObject(entry, `${label}[${index}]`);
		return {
			label: readString(obj.label, `${label}[${index}].label`),
			value: readString(obj.value, `${label}[${index}].value`),
			description: readOptionalString(obj.description),
			emoji: typeof obj.emoji === "object" && obj.emoji && !Array.isArray(obj.emoji) ? {
				name: readString(obj.emoji.name, `${label}[${index}].emoji.name`),
				id: readOptionalString(obj.emoji.id),
				animated: typeof obj.emoji.animated === "boolean" ? obj.emoji.animated : void 0
			} : void 0,
			default: typeof obj.default === "boolean" ? obj.default : void 0
		};
	});
}
function parseButtonSpec(raw, label) {
	const obj = requireObject(raw, label);
	const style = readOptionalString(obj.style);
	const url = readOptionalString(obj.url);
	if ((style === "link" || url) && !url) throw new Error(`${label}.url is required for link buttons`);
	return {
		label: readString(obj.label, `${label}.label`),
		style,
		url,
		emoji: typeof obj.emoji === "object" && obj.emoji && !Array.isArray(obj.emoji) ? {
			name: readString(obj.emoji.name, `${label}.emoji.name`),
			id: readOptionalString(obj.emoji.id),
			animated: typeof obj.emoji.animated === "boolean" ? obj.emoji.animated : void 0
		} : void 0,
		disabled: typeof obj.disabled === "boolean" ? obj.disabled : void 0,
		allowedUsers: readOptionalStringArray(obj.allowedUsers, `${label}.allowedUsers`)
	};
}
function parseSelectSpec(raw, label) {
	const obj = requireObject(raw, label);
	const type = readOptionalString(obj.type);
	const allowedTypes = [
		"string",
		"user",
		"role",
		"mentionable",
		"channel"
	];
	if (type && !allowedTypes.includes(type)) throw new Error(`${label}.type must be one of ${allowedTypes.join(", ")}`);
	return {
		type,
		placeholder: readOptionalString(obj.placeholder),
		minValues: readOptionalNumber(obj.minValues),
		maxValues: readOptionalNumber(obj.maxValues),
		options: parseSelectOptions(obj.options, `${label}.options`)
	};
}
function parseModalField(raw, label, index) {
	const obj = requireObject(raw, label);
	const type = readString(obj.type, `${label}.type`).toLowerCase();
	const supported = [
		"text",
		"checkbox",
		"radio",
		"select",
		"role-select",
		"user-select"
	];
	if (!supported.includes(type)) throw new Error(`${label}.type must be one of ${supported.join(", ")}`);
	const options = parseSelectOptions(obj.options, `${label}.options`);
	if ([
		"checkbox",
		"radio",
		"select"
	].includes(type) && (!options || options.length === 0)) throw new Error(`${label}.options is required for ${type} fields`);
	return {
		type,
		name: normalizeModalFieldName(readOptionalString(obj.name), index),
		label: readString(obj.label, `${label}.label`),
		description: readOptionalString(obj.description),
		placeholder: readOptionalString(obj.placeholder),
		required: typeof obj.required === "boolean" ? obj.required : void 0,
		options,
		minValues: readOptionalNumber(obj.minValues),
		maxValues: readOptionalNumber(obj.maxValues),
		minLength: readOptionalNumber(obj.minLength),
		maxLength: readOptionalNumber(obj.maxLength),
		style: readOptionalString(obj.style)
	};
}
function parseComponentBlock(raw, label) {
	const obj = requireObject(raw, label);
	switch (normalizeBlockType(readString(obj.type, `${label}.type`).toLowerCase())) {
		case "text": return {
			type: "text",
			text: readString(obj.text, `${label}.text`)
		};
		case "section": {
			const text = readOptionalString(obj.text);
			const textsRaw = obj.texts;
			const texts = Array.isArray(textsRaw) ? textsRaw.map((entry, idx) => readString(entry, `${label}.texts[${idx}]`)) : void 0;
			if (!text && (!texts || texts.length === 0)) throw new Error(`${label}.text or ${label}.texts is required for section blocks`);
			let accessory;
			if (obj.accessory !== void 0) {
				const accessoryObj = requireObject(obj.accessory, `${label}.accessory`);
				const accessoryType = readString(accessoryObj.type, `${label}.accessory.type`).toLowerCase();
				if (accessoryType === "thumbnail") accessory = {
					type: "thumbnail",
					url: readString(accessoryObj.url, `${label}.accessory.url`)
				};
				else if (accessoryType === "button") accessory = {
					type: "button",
					button: parseButtonSpec(accessoryObj.button, `${label}.accessory.button`)
				};
				else throw new Error(`${label}.accessory.type must be "thumbnail" or "button"`);
			}
			return {
				type: "section",
				text,
				texts,
				accessory
			};
		}
		case "separator": {
			const spacingRaw = obj.spacing;
			let spacing;
			if (spacingRaw === "small" || spacingRaw === "large") spacing = spacingRaw;
			else if (spacingRaw === 1 || spacingRaw === 2) spacing = spacingRaw;
			else if (spacingRaw !== void 0) throw new Error(`${label}.spacing must be "small", "large", 1, or 2`);
			const divider = typeof obj.divider === "boolean" ? obj.divider : void 0;
			return {
				type: "separator",
				spacing,
				divider
			};
		}
		case "actions": {
			const buttonsRaw = obj.buttons;
			const buttons = Array.isArray(buttonsRaw) ? buttonsRaw.map((entry, idx) => parseButtonSpec(entry, `${label}.buttons[${idx}]`)) : void 0;
			const select = obj.select ? parseSelectSpec(obj.select, `${label}.select`) : void 0;
			if ((!buttons || buttons.length === 0) && !select) throw new Error(`${label} requires buttons or select`);
			if (buttons && select) throw new Error(`${label} cannot include both buttons and select`);
			return {
				type: "actions",
				buttons,
				select
			};
		}
		case "media-gallery": {
			const itemsRaw = obj.items;
			if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) throw new Error(`${label}.items must be a non-empty array`);
			return {
				type: "media-gallery",
				items: itemsRaw.map((entry, idx) => {
					const itemObj = requireObject(entry, `${label}.items[${idx}]`);
					return {
						url: readString(itemObj.url, `${label}.items[${idx}].url`),
						description: readOptionalString(itemObj.description),
						spoiler: typeof itemObj.spoiler === "boolean" ? itemObj.spoiler : void 0
					};
				})
			};
		}
		case "file": return {
			type: "file",
			file: normalizeAttachmentRef(readString(obj.file, `${label}.file`), `${label}.file`),
			spoiler: typeof obj.spoiler === "boolean" ? obj.spoiler : void 0
		};
		default: throw new Error(`${label}.type must be a supported component block`);
	}
}
function readDiscordComponentSpec(raw) {
	if (raw === void 0 || raw === null) return null;
	const obj = requireObject(raw, "components");
	const blocksRaw = obj.blocks;
	const blocks = Array.isArray(blocksRaw) ? blocksRaw.map((entry, idx) => parseComponentBlock(entry, `components.blocks[${idx}]`)) : void 0;
	const modalRaw = obj.modal;
	const reusable = typeof obj.reusable === "boolean" ? obj.reusable : void 0;
	let modal;
	if (modalRaw !== void 0) {
		const modalObj = requireObject(modalRaw, "components.modal");
		const fieldsRaw = modalObj.fields;
		if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) throw new Error("components.modal.fields must be a non-empty array");
		if (fieldsRaw.length > 5) throw new Error("components.modal.fields supports up to 5 inputs");
		const fields = fieldsRaw.map((entry, idx) => parseModalField(entry, `components.modal.fields[${idx}]`, idx));
		modal = {
			title: readString(modalObj.title, "components.modal.title"),
			triggerLabel: readOptionalString(modalObj.triggerLabel),
			triggerStyle: readOptionalString(modalObj.triggerStyle),
			fields
		};
	}
	return {
		text: readOptionalString(obj.text),
		reusable,
		container: typeof obj.container === "object" && obj.container && !Array.isArray(obj.container) ? {
			accentColor: obj.container.accentColor,
			spoiler: typeof obj.container.spoiler === "boolean" ? obj.container.spoiler : void 0
		} : void 0,
		blocks,
		modal
	};
}
function buildDiscordComponentCustomId(params) {
	const base = `${DISCORD_COMPONENT_CUSTOM_ID_KEY}:cid=${params.componentId}`;
	return params.modalId ? `${base};mid=${params.modalId}` : base;
}
function buildTextDisplays(text, texts) {
	if (texts && texts.length > 0) return texts.map((entry) => new TextDisplay(entry));
	if (text) return [new TextDisplay(text)];
	return [];
}
function createButtonComponent(params) {
	const style = mapButtonStyle(params.spec.style);
	if (style === ButtonStyle.Link || Boolean(params.spec.url)) {
		if (!params.spec.url) throw new Error("Link buttons require a url");
		const linkUrl = params.spec.url;
		class DynamicLinkButton extends LinkButton {
			constructor(..._args) {
				super(..._args);
				this.label = params.spec.label;
				this.url = linkUrl;
			}
		}
		return { component: new DynamicLinkButton() };
	}
	const componentId = params.componentId ?? createShortId("btn_");
	const customId = buildDiscordComponentCustomId({
		componentId,
		modalId: params.modalId
	});
	class DynamicButton extends Button {
		constructor(..._args2) {
			super(..._args2);
			this.label = params.spec.label;
			this.customId = customId;
			this.style = style;
			this.emoji = params.spec.emoji;
			this.disabled = params.spec.disabled ?? false;
		}
	}
	return {
		component: new DynamicButton(),
		entry: {
			id: componentId,
			kind: params.modalId ? "modal-trigger" : "button",
			label: params.spec.label,
			modalId: params.modalId,
			allowedUsers: params.spec.allowedUsers
		}
	};
}
function createSelectComponent(params) {
	const type = (params.spec.type ?? "string").toLowerCase();
	const componentId = params.componentId ?? createShortId("sel_");
	const customId = buildDiscordComponentCustomId({ componentId });
	if (type === "string") {
		const options = params.spec.options ?? [];
		if (options.length === 0) throw new Error("String select menus require options");
		class DynamicStringSelect extends StringSelectMenu {
			constructor(..._args3) {
				super(..._args3);
				this.customId = customId;
				this.options = options;
				this.minValues = params.spec.minValues;
				this.maxValues = params.spec.maxValues;
				this.placeholder = params.spec.placeholder;
				this.disabled = false;
			}
		}
		return {
			component: new DynamicStringSelect(),
			entry: {
				id: componentId,
				kind: "select",
				label: params.spec.placeholder ?? "select",
				selectType: "string",
				options: options.map((option) => ({
					value: option.value,
					label: option.label
				}))
			}
		};
	}
	if (type === "user") {
		class DynamicUserSelect extends UserSelectMenu {
			constructor(..._args4) {
				super(..._args4);
				this.customId = customId;
				this.minValues = params.spec.minValues;
				this.maxValues = params.spec.maxValues;
				this.placeholder = params.spec.placeholder;
				this.disabled = false;
			}
		}
		return {
			component: new DynamicUserSelect(),
			entry: {
				id: componentId,
				kind: "select",
				label: params.spec.placeholder ?? "user select",
				selectType: "user"
			}
		};
	}
	if (type === "role") {
		class DynamicRoleSelect extends RoleSelectMenu {
			constructor(..._args5) {
				super(..._args5);
				this.customId = customId;
				this.minValues = params.spec.minValues;
				this.maxValues = params.spec.maxValues;
				this.placeholder = params.spec.placeholder;
				this.disabled = false;
			}
		}
		return {
			component: new DynamicRoleSelect(),
			entry: {
				id: componentId,
				kind: "select",
				label: params.spec.placeholder ?? "role select",
				selectType: "role"
			}
		};
	}
	if (type === "mentionable") {
		class DynamicMentionableSelect extends MentionableSelectMenu {
			constructor(..._args6) {
				super(..._args6);
				this.customId = customId;
				this.minValues = params.spec.minValues;
				this.maxValues = params.spec.maxValues;
				this.placeholder = params.spec.placeholder;
				this.disabled = false;
			}
		}
		return {
			component: new DynamicMentionableSelect(),
			entry: {
				id: componentId,
				kind: "select",
				label: params.spec.placeholder ?? "mentionable select",
				selectType: "mentionable"
			}
		};
	}
	class DynamicChannelSelect extends ChannelSelectMenu {
		constructor(..._args7) {
			super(..._args7);
			this.customId = customId;
			this.minValues = params.spec.minValues;
			this.maxValues = params.spec.maxValues;
			this.placeholder = params.spec.placeholder;
			this.disabled = false;
		}
	}
	return {
		component: new DynamicChannelSelect(),
		entry: {
			id: componentId,
			kind: "select",
			label: params.spec.placeholder ?? "channel select",
			selectType: "channel"
		}
	};
}
function isSelectComponent(component) {
	return component instanceof StringSelectMenu || component instanceof UserSelectMenu || component instanceof RoleSelectMenu || component instanceof MentionableSelectMenu || component instanceof ChannelSelectMenu;
}
function buildDiscordComponentMessage(params) {
	const entries = [];
	const modals = [];
	const components = [];
	const containerChildren = [];
	const addEntry = (entry) => {
		entries.push({
			...entry,
			sessionKey: params.sessionKey,
			agentId: params.agentId,
			accountId: params.accountId,
			reusable: entry.reusable ?? params.spec.reusable
		});
	};
	const text = params.spec.text ?? params.fallbackText;
	if (text) containerChildren.push(new TextDisplay(text));
	for (const block of params.spec.blocks ?? []) {
		if (block.type === "text") {
			containerChildren.push(new TextDisplay(block.text));
			continue;
		}
		if (block.type === "section") {
			const displays = buildTextDisplays(block.text, block.texts);
			if (displays.length > 3) throw new Error("Section blocks support up to 3 text displays");
			let accessory;
			if (block.accessory?.type === "thumbnail") accessory = new Thumbnail(block.accessory.url);
			else if (block.accessory?.type === "button") {
				const { component, entry } = createButtonComponent({ spec: block.accessory.button });
				accessory = component;
				if (entry) addEntry(entry);
			}
			containerChildren.push(new Section(displays, accessory));
			continue;
		}
		if (block.type === "separator") {
			containerChildren.push(new Separator({
				spacing: block.spacing,
				divider: block.divider
			}));
			continue;
		}
		if (block.type === "media-gallery") {
			containerChildren.push(new MediaGallery(block.items));
			continue;
		}
		if (block.type === "file") {
			containerChildren.push(new File(block.file, block.spoiler));
			continue;
		}
		if (block.type === "actions") {
			const rowComponents = [];
			if (block.buttons) {
				if (block.buttons.length > 5) throw new Error("Action rows support up to 5 buttons");
				for (const button of block.buttons) {
					const { component, entry } = createButtonComponent({ spec: button });
					rowComponents.push(component);
					if (entry) addEntry(entry);
				}
			} else if (block.select) {
				const { component, entry } = createSelectComponent({ spec: block.select });
				rowComponents.push(component);
				addEntry(entry);
			}
			containerChildren.push(new Row(rowComponents));
		}
	}
	if (params.spec.modal) {
		const modalId = createShortId("mdl_");
		const fields = params.spec.modal.fields.map((field, index) => ({
			id: createShortId("fld_"),
			name: normalizeModalFieldName(field.name, index),
			label: field.label,
			type: field.type,
			description: field.description,
			placeholder: field.placeholder,
			required: field.required,
			options: field.options,
			minValues: field.minValues,
			maxValues: field.maxValues,
			minLength: field.minLength,
			maxLength: field.maxLength,
			style: field.style
		}));
		modals.push({
			id: modalId,
			title: params.spec.modal.title,
			fields,
			sessionKey: params.sessionKey,
			agentId: params.agentId,
			accountId: params.accountId,
			reusable: params.spec.reusable
		});
		const { component, entry } = createButtonComponent({
			spec: {
				label: params.spec.modal.triggerLabel ?? "Open form",
				style: params.spec.modal.triggerStyle ?? "primary"
			},
			modalId
		});
		if (entry) addEntry(entry);
		const lastChild = containerChildren.at(-1);
		if (lastChild instanceof Row) {
			const row = lastChild;
			const hasSelect = row.components.some((entry) => isSelectComponent(entry));
			if (row.components.length < 5 && !hasSelect) row.addComponent(component);
			else containerChildren.push(new Row([component]));
		} else containerChildren.push(new Row([component]));
	}
	if (containerChildren.length === 0) throw new Error("components must include at least one block, text, or modal trigger");
	const container = new Container(containerChildren, params.spec.container);
	components.push(container);
	return {
		components,
		entries,
		modals
	};
}
function buildDiscordComponentMessageFlags(components) {
	return components.some((component) => component.isV2) ? MessageFlags.IsComponentsV2 : void 0;
}

//#endregion
//#region src/discord/send.components.ts
const DISCORD_FORUM_LIKE_TYPES = new Set([ChannelType.GuildForum, ChannelType.GuildMedia]);
function extractComponentAttachmentNames(spec) {
	const names = [];
	for (const block of spec.blocks ?? []) if (block.type === "file") names.push(resolveDiscordComponentAttachmentName(block.file));
	return names;
}
async function sendDiscordComponentMessage(to, spec, opts = {}) {
	const cfg = opts.cfg ?? loadConfig();
	const accountInfo = resolveDiscordAccount({
		cfg,
		accountId: opts.accountId
	});
	const { token, rest, request } = createDiscordClient(opts, cfg);
	const { channelId } = await resolveChannelId(rest, await parseAndResolveRecipient(to, opts.accountId, cfg), request);
	const channelType = await resolveDiscordChannelType(rest, channelId);
	if (channelType && DISCORD_FORUM_LIKE_TYPES.has(channelType)) throw new Error("Discord components are not supported in forum-style channels");
	const buildResult = buildDiscordComponentMessage({
		spec,
		sessionKey: opts.sessionKey,
		agentId: opts.agentId,
		accountId: accountInfo.accountId
	});
	const flags = buildDiscordComponentMessageFlags(buildResult.components);
	const finalFlags = opts.silent ? (flags ?? 0) | SUPPRESS_NOTIFICATIONS_FLAG$1 : flags ?? void 0;
	const messageReference = opts.replyTo ? {
		message_id: opts.replyTo,
		fail_if_not_exists: false
	} : void 0;
	const attachmentNames = extractComponentAttachmentNames(spec);
	const uniqueAttachmentNames = [...new Set(attachmentNames)];
	if (uniqueAttachmentNames.length > 1) throw new Error("Discord component attachments currently support a single file. Use media-gallery for multiple files.");
	const expectedAttachmentName = uniqueAttachmentNames[0];
	let files;
	if (opts.mediaUrl) {
		const media = await loadWebMedia(opts.mediaUrl, { localRoots: opts.mediaLocalRoots });
		const fileName = opts.filename?.trim() || media.fileName || "upload";
		if (expectedAttachmentName && expectedAttachmentName !== fileName) throw new Error(`Component file block expects attachment "${expectedAttachmentName}", but the uploaded file is "${fileName}". Update components.blocks[].file or provide a matching filename.`);
		files = [{
			data: toDiscordFileBlob(media.buffer),
			name: fileName
		}];
	} else if (expectedAttachmentName) throw new Error("Discord component file blocks require a media attachment (media/path/filePath).");
	const body = stripUndefinedFields({
		...serializePayload({
			components: buildResult.components,
			...finalFlags ? { flags: finalFlags } : {},
			...files ? { files } : {}
		}),
		...messageReference ? { message_reference: messageReference } : {}
	});
	let result;
	try {
		result = await request(() => rest.post(Routes.channelMessages(channelId), { body }), "components");
	} catch (err) {
		throw await buildDiscordSendError(err, {
			channelId,
			rest,
			token,
			hasMedia: Boolean(files?.length)
		});
	}
	registerDiscordComponentEntries({
		entries: buildResult.entries,
		modals: buildResult.modals,
		messageId: result.id
	});
	recordChannelActivity({
		channel: "discord",
		accountId: accountInfo.accountId,
		direction: "outbound"
	});
	return {
		messageId: result.id ?? "unknown",
		channelId: result.channel_id ?? channelId
	};
}

//#endregion
//#region src/discord/send.reactions.ts
async function reactMessageDiscord(channelId, messageId, emoji, opts = {}) {
	const { rest, request } = createDiscordClient(opts, opts.cfg ?? loadConfig());
	const encoded = normalizeReactionEmoji(emoji);
	await request(() => rest.put(Routes.channelMessageOwnReaction(channelId, messageId, encoded)), "react");
	return { ok: true };
}
async function removeReactionDiscord(channelId, messageId, emoji, opts = {}) {
	const { rest } = createDiscordClient(opts, opts.cfg ?? loadConfig());
	const encoded = normalizeReactionEmoji(emoji);
	await rest.delete(Routes.channelMessageOwnReaction(channelId, messageId, encoded));
	return { ok: true };
}
async function removeOwnReactionsDiscord(channelId, messageId, opts = {}) {
	const { rest } = createDiscordClient(opts, opts.cfg ?? loadConfig());
	const message = await rest.get(Routes.channelMessage(channelId, messageId));
	const identifiers = /* @__PURE__ */ new Set();
	for (const reaction of message.reactions ?? []) {
		const identifier = buildReactionIdentifier(reaction.emoji);
		if (identifier) identifiers.add(identifier);
	}
	if (identifiers.size === 0) return {
		ok: true,
		removed: []
	};
	const removed = [];
	await Promise.allSettled(Array.from(identifiers, (identifier) => {
		removed.push(identifier);
		return rest.delete(Routes.channelMessageOwnReaction(channelId, messageId, normalizeReactionEmoji(identifier)));
	}));
	return {
		ok: true,
		removed
	};
}
async function fetchReactionsDiscord(channelId, messageId, opts = {}) {
	const { rest } = createDiscordClient(opts, opts.cfg ?? loadConfig());
	const reactions = (await rest.get(Routes.channelMessage(channelId, messageId))).reactions ?? [];
	if (reactions.length === 0) return [];
	const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) ? Math.min(Math.max(Math.floor(opts.limit), 1), 100) : 100;
	const summaries = [];
	for (const reaction of reactions) {
		const identifier = buildReactionIdentifier(reaction.emoji);
		if (!identifier) continue;
		const encoded = encodeURIComponent(identifier);
		const users = await rest.get(Routes.channelMessageReaction(channelId, messageId, encoded), { limit });
		summaries.push({
			emoji: {
				id: reaction.emoji.id ?? null,
				name: reaction.emoji.name ?? null,
				raw: formatReactionEmoji(reaction.emoji)
			},
			count: reaction.count,
			users: users.map((user) => ({
				id: user.id,
				username: user.username,
				tag: user.username && user.discriminator ? `${user.username}#${user.discriminator}` : user.username
			}))
		});
	}
	return summaries;
}

//#endregion
//#region src/agents/tools/discord-actions-guild.ts
async function runRoleMutation(params) {
	const guildId = readStringParam(params.values, "guildId", { required: true });
	const userId = readStringParam(params.values, "userId", { required: true });
	const roleId = readStringParam(params.values, "roleId", { required: true });
	if (params.accountId) {
		await params.mutate({
			guildId,
			userId,
			roleId
		}, { accountId: params.accountId });
		return;
	}
	await params.mutate({
		guildId,
		userId,
		roleId
	});
}
async function handleDiscordGuildAction(action, params, isActionEnabled) {
	const accountId = readStringParam(params, "accountId");
	switch (action) {
		case "memberInfo": {
			if (!isActionEnabled("memberInfo")) throw new Error("Discord member info is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const userId = readStringParam(params, "userId", { required: true });
			const member = accountId ? await fetchMemberInfoDiscord(guildId, userId, { accountId }) : await fetchMemberInfoDiscord(guildId, userId);
			const presence = getPresence(accountId, userId);
			const activities = presence?.activities ?? void 0;
			const status = presence?.status ?? void 0;
			return jsonResult({
				ok: true,
				member,
				...presence ? {
					status,
					activities
				} : {}
			});
		}
		case "roleInfo": {
			if (!isActionEnabled("roleInfo")) throw new Error("Discord role info is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			return jsonResult({
				ok: true,
				roles: accountId ? await fetchRoleInfoDiscord(guildId, { accountId }) : await fetchRoleInfoDiscord(guildId)
			});
		}
		case "emojiList": {
			if (!isActionEnabled("reactions")) throw new Error("Discord reactions are disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			return jsonResult({
				ok: true,
				emojis: accountId ? await listGuildEmojisDiscord(guildId, { accountId }) : await listGuildEmojisDiscord(guildId)
			});
		}
		case "emojiUpload": {
			if (!isActionEnabled("emojiUploads")) throw new Error("Discord emoji uploads are disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const name = readStringParam(params, "name", { required: true });
			const mediaUrl = readStringParam(params, "mediaUrl", { required: true });
			const roleIds = readStringArrayParam(params, "roleIds");
			return jsonResult({
				ok: true,
				emoji: accountId ? await uploadEmojiDiscord({
					guildId,
					name,
					mediaUrl,
					roleIds: roleIds?.length ? roleIds : void 0
				}, { accountId }) : await uploadEmojiDiscord({
					guildId,
					name,
					mediaUrl,
					roleIds: roleIds?.length ? roleIds : void 0
				})
			});
		}
		case "stickerUpload": {
			if (!isActionEnabled("stickerUploads")) throw new Error("Discord sticker uploads are disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const name = readStringParam(params, "name", { required: true });
			const description = readStringParam(params, "description", { required: true });
			const tags = readStringParam(params, "tags", { required: true });
			const mediaUrl = readStringParam(params, "mediaUrl", { required: true });
			return jsonResult({
				ok: true,
				sticker: accountId ? await uploadStickerDiscord({
					guildId,
					name,
					description,
					tags,
					mediaUrl
				}, { accountId }) : await uploadStickerDiscord({
					guildId,
					name,
					description,
					tags,
					mediaUrl
				})
			});
		}
		case "roleAdd":
			if (!isActionEnabled("roles", false)) throw new Error("Discord role changes are disabled.");
			await runRoleMutation({
				accountId,
				values: params,
				mutate: addRoleDiscord
			});
			return jsonResult({ ok: true });
		case "roleRemove":
			if (!isActionEnabled("roles", false)) throw new Error("Discord role changes are disabled.");
			await runRoleMutation({
				accountId,
				values: params,
				mutate: removeRoleDiscord
			});
			return jsonResult({ ok: true });
		case "channelInfo": {
			if (!isActionEnabled("channelInfo")) throw new Error("Discord channel info is disabled.");
			const channelId = readStringParam(params, "channelId", { required: true });
			return jsonResult({
				ok: true,
				channel: accountId ? await fetchChannelInfoDiscord(channelId, { accountId }) : await fetchChannelInfoDiscord(channelId)
			});
		}
		case "channelList": {
			if (!isActionEnabled("channelInfo")) throw new Error("Discord channel info is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			return jsonResult({
				ok: true,
				channels: accountId ? await listGuildChannelsDiscord(guildId, { accountId }) : await listGuildChannelsDiscord(guildId)
			});
		}
		case "voiceStatus": {
			if (!isActionEnabled("voiceStatus")) throw new Error("Discord voice status is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const userId = readStringParam(params, "userId", { required: true });
			return jsonResult({
				ok: true,
				voice: accountId ? await fetchVoiceStatusDiscord(guildId, userId, { accountId }) : await fetchVoiceStatusDiscord(guildId, userId)
			});
		}
		case "eventList": {
			if (!isActionEnabled("events")) throw new Error("Discord events are disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			return jsonResult({
				ok: true,
				events: accountId ? await listScheduledEventsDiscord(guildId, { accountId }) : await listScheduledEventsDiscord(guildId)
			});
		}
		case "eventCreate": {
			if (!isActionEnabled("events")) throw new Error("Discord events are disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const name = readStringParam(params, "name", { required: true });
			const startTime = readStringParam(params, "startTime", { required: true });
			const endTime = readStringParam(params, "endTime");
			const description = readStringParam(params, "description");
			const channelId = readStringParam(params, "channelId");
			const location = readStringParam(params, "location");
			const entityTypeRaw = readStringParam(params, "entityType");
			const entityType = entityTypeRaw === "stage" ? 1 : entityTypeRaw === "external" ? 3 : 2;
			const payload = {
				name,
				description,
				scheduled_start_time: startTime,
				scheduled_end_time: endTime,
				entity_type: entityType,
				channel_id: channelId,
				entity_metadata: entityType === 3 && location ? { location } : void 0,
				privacy_level: 2
			};
			return jsonResult({
				ok: true,
				event: accountId ? await createScheduledEventDiscord(guildId, payload, { accountId }) : await createScheduledEventDiscord(guildId, payload)
			});
		}
		case "channelCreate": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const name = readStringParam(params, "name", { required: true });
			const type = readNumberParam(params, "type", { integer: true });
			const parentId = readDiscordParentIdParam(params);
			const topic = readStringParam(params, "topic");
			const position = readNumberParam(params, "position", { integer: true });
			const nsfw = params.nsfw;
			return jsonResult({
				ok: true,
				channel: accountId ? await createChannelDiscord({
					guildId,
					name,
					type: type ?? void 0,
					parentId: parentId ?? void 0,
					topic: topic ?? void 0,
					position: position ?? void 0,
					nsfw
				}, { accountId }) : await createChannelDiscord({
					guildId,
					name,
					type: type ?? void 0,
					parentId: parentId ?? void 0,
					topic: topic ?? void 0,
					position: position ?? void 0,
					nsfw
				})
			});
		}
		case "channelEdit": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const channelId = readStringParam(params, "channelId", { required: true });
			const name = readStringParam(params, "name");
			const topic = readStringParam(params, "topic");
			const position = readNumberParam(params, "position", { integer: true });
			const parentId = readDiscordParentIdParam(params);
			const nsfw = params.nsfw;
			const rateLimitPerUser = readNumberParam(params, "rateLimitPerUser", { integer: true });
			const archived = typeof params.archived === "boolean" ? params.archived : void 0;
			const locked = typeof params.locked === "boolean" ? params.locked : void 0;
			const autoArchiveDuration = readNumberParam(params, "autoArchiveDuration", { integer: true });
			const availableTags = parseAvailableTags(params.availableTags);
			const editPayload = {
				channelId,
				name: name ?? void 0,
				topic: topic ?? void 0,
				position: position ?? void 0,
				parentId,
				nsfw,
				rateLimitPerUser: rateLimitPerUser ?? void 0,
				archived,
				locked,
				autoArchiveDuration: autoArchiveDuration ?? void 0,
				availableTags
			};
			return jsonResult({
				ok: true,
				channel: accountId ? await editChannelDiscord(editPayload, { accountId }) : await editChannelDiscord(editPayload)
			});
		}
		case "channelDelete": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const channelId = readStringParam(params, "channelId", { required: true });
			return jsonResult(accountId ? await deleteChannelDiscord(channelId, { accountId }) : await deleteChannelDiscord(channelId));
		}
		case "channelMove": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const channelId = readStringParam(params, "channelId", { required: true });
			const parentId = readDiscordParentIdParam(params);
			const position = readNumberParam(params, "position", { integer: true });
			if (accountId) await moveChannelDiscord({
				guildId,
				channelId,
				parentId,
				position: position ?? void 0
			}, { accountId });
			else await moveChannelDiscord({
				guildId,
				channelId,
				parentId,
				position: position ?? void 0
			});
			return jsonResult({ ok: true });
		}
		case "categoryCreate": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const name = readStringParam(params, "name", { required: true });
			const position = readNumberParam(params, "position", { integer: true });
			return jsonResult({
				ok: true,
				category: accountId ? await createChannelDiscord({
					guildId,
					name,
					type: 4,
					position: position ?? void 0
				}, { accountId }) : await createChannelDiscord({
					guildId,
					name,
					type: 4,
					position: position ?? void 0
				})
			});
		}
		case "categoryEdit": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const categoryId = readStringParam(params, "categoryId", { required: true });
			const name = readStringParam(params, "name");
			const position = readNumberParam(params, "position", { integer: true });
			return jsonResult({
				ok: true,
				category: accountId ? await editChannelDiscord({
					channelId: categoryId,
					name: name ?? void 0,
					position: position ?? void 0
				}, { accountId }) : await editChannelDiscord({
					channelId: categoryId,
					name: name ?? void 0,
					position: position ?? void 0
				})
			});
		}
		case "categoryDelete": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const categoryId = readStringParam(params, "categoryId", { required: true });
			return jsonResult(accountId ? await deleteChannelDiscord(categoryId, { accountId }) : await deleteChannelDiscord(categoryId));
		}
		case "channelPermissionSet": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const channelId = readStringParam(params, "channelId", { required: true });
			const targetId = readStringParam(params, "targetId", { required: true });
			const targetType = readStringParam(params, "targetType", { required: true }) === "member" ? 1 : 0;
			const allow = readStringParam(params, "allow");
			const deny = readStringParam(params, "deny");
			if (accountId) await setChannelPermissionDiscord({
				channelId,
				targetId,
				targetType,
				allow: allow ?? void 0,
				deny: deny ?? void 0
			}, { accountId });
			else await setChannelPermissionDiscord({
				channelId,
				targetId,
				targetType,
				allow: allow ?? void 0,
				deny: deny ?? void 0
			});
			return jsonResult({ ok: true });
		}
		case "channelPermissionRemove": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const channelId = readStringParam(params, "channelId", { required: true });
			const targetId = readStringParam(params, "targetId", { required: true });
			if (accountId) await removeChannelPermissionDiscord(channelId, targetId, { accountId });
			else await removeChannelPermissionDiscord(channelId, targetId);
			return jsonResult({ ok: true });
		}
		default: throw new Error(`Unknown action: ${action}`);
	}
}

//#endregion
//#region src/agents/date-time.ts
function normalizeTimestamp(raw) {
	if (raw == null) return;
	let timestampMs;
	if (raw instanceof Date) timestampMs = raw.getTime();
	else if (typeof raw === "number" && Number.isFinite(raw)) timestampMs = raw < 0xe8d4a51000 ? Math.round(raw * 1e3) : Math.round(raw);
	else if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return;
		if (/^\d+(\.\d+)?$/.test(trimmed)) {
			const num = Number(trimmed);
			if (Number.isFinite(num)) if (trimmed.includes(".")) timestampMs = Math.round(num * 1e3);
			else if (trimmed.length >= 13) timestampMs = Math.round(num);
			else timestampMs = Math.round(num * 1e3);
		} else {
			const parsed = Date.parse(trimmed);
			if (!Number.isNaN(parsed)) timestampMs = parsed;
		}
	}
	if (timestampMs === void 0 || !Number.isFinite(timestampMs)) return;
	return {
		timestampMs,
		timestampUtc: new Date(timestampMs).toISOString()
	};
}
function withNormalizedTimestamp(value, rawTimestamp) {
	const normalized = normalizeTimestamp(rawTimestamp);
	if (!normalized) return value;
	return {
		...value,
		timestampMs: typeof value.timestampMs === "number" && Number.isFinite(value.timestampMs) ? value.timestampMs : normalized.timestampMs,
		timestampUtc: typeof value.timestampUtc === "string" && value.timestampUtc.trim() ? value.timestampUtc : normalized.timestampUtc
	};
}

//#endregion
//#region src/agents/tools/discord-actions-messaging.ts
function parseDiscordMessageLink(link) {
	const match = link.trim().match(/^(?:https?:\/\/)?(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)(?:\/?|\?.*)$/i);
	if (!match) throw new Error("Invalid Discord message link. Expected https://discord.com/channels/<guildId>/<channelId>/<messageId>.");
	return {
		guildId: match[1],
		channelId: match[2],
		messageId: match[3]
	};
}
async function handleDiscordMessagingAction(action, params, isActionEnabled, options, cfg) {
	const resolveChannelId = () => resolveDiscordChannelId(readStringParam(params, "channelId", { required: true }));
	const accountId = readStringParam(params, "accountId");
	const cfgOptions = cfg ? { cfg } : {};
	const normalizeMessage = (message) => {
		if (!message || typeof message !== "object") return message;
		return withNormalizedTimestamp(message, message.timestamp);
	};
	switch (action) {
		case "react": {
			if (!isActionEnabled("reactions")) throw new Error("Discord reactions are disabled.");
			const channelId = resolveChannelId();
			const messageId = readStringParam(params, "messageId", { required: true });
			const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove a Discord reaction." });
			if (remove) {
				if (accountId) await removeReactionDiscord(channelId, messageId, emoji, {
					...cfgOptions,
					accountId
				});
				else await removeReactionDiscord(channelId, messageId, emoji, cfgOptions);
				return jsonResult({
					ok: true,
					removed: emoji
				});
			}
			if (isEmpty) return jsonResult({
				ok: true,
				removed: (accountId ? await removeOwnReactionsDiscord(channelId, messageId, {
					...cfgOptions,
					accountId
				}) : await removeOwnReactionsDiscord(channelId, messageId, cfgOptions)).removed
			});
			if (accountId) await reactMessageDiscord(channelId, messageId, emoji, {
				...cfgOptions,
				accountId
			});
			else await reactMessageDiscord(channelId, messageId, emoji, cfgOptions);
			return jsonResult({
				ok: true,
				added: emoji
			});
		}
		case "reactions": {
			if (!isActionEnabled("reactions")) throw new Error("Discord reactions are disabled.");
			const channelId = resolveChannelId();
			const messageId = readStringParam(params, "messageId", { required: true });
			const limitRaw = params.limit;
			const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : void 0;
			return jsonResult({
				ok: true,
				reactions: await fetchReactionsDiscord(channelId, messageId, {
					...cfgOptions,
					...accountId ? { accountId } : {},
					limit
				})
			});
		}
		case "sticker": {
			if (!isActionEnabled("stickers")) throw new Error("Discord stickers are disabled.");
			const to = readStringParam(params, "to", { required: true });
			const content = readStringParam(params, "content");
			await sendStickerDiscord(to, readStringArrayParam(params, "stickerIds", {
				required: true,
				label: "stickerIds"
			}), {
				...cfgOptions,
				...accountId ? { accountId } : {},
				content
			});
			return jsonResult({ ok: true });
		}
		case "poll": {
			if (!isActionEnabled("polls")) throw new Error("Discord polls are disabled.");
			const to = readStringParam(params, "to", { required: true });
			const content = readStringParam(params, "content");
			const question = readStringParam(params, "question", { required: true });
			const answers = readStringArrayParam(params, "answers", {
				required: true,
				label: "answers"
			});
			const allowMultiselectRaw = params.allowMultiselect;
			const allowMultiselect = typeof allowMultiselectRaw === "boolean" ? allowMultiselectRaw : void 0;
			const durationRaw = params.durationHours;
			const durationHours = typeof durationRaw === "number" && Number.isFinite(durationRaw) ? durationRaw : void 0;
			await sendPollDiscord(to, {
				question,
				options: answers,
				maxSelections: allowMultiselect ? Math.max(2, answers.length) : 1,
				durationHours
			}, {
				...cfgOptions,
				...accountId ? { accountId } : {},
				content
			});
			return jsonResult({ ok: true });
		}
		case "permissions": {
			if (!isActionEnabled("permissions")) throw new Error("Discord permissions are disabled.");
			const channelId = resolveChannelId();
			return jsonResult({
				ok: true,
				permissions: accountId ? await fetchChannelPermissionsDiscord(channelId, { accountId }) : await fetchChannelPermissionsDiscord(channelId)
			});
		}
		case "fetchMessage": {
			if (!isActionEnabled("messages")) throw new Error("Discord message reads are disabled.");
			const messageLink = readStringParam(params, "messageLink");
			let guildId = readStringParam(params, "guildId");
			let channelId = readStringParam(params, "channelId");
			let messageId = readStringParam(params, "messageId");
			if (messageLink) {
				const parsed = parseDiscordMessageLink(messageLink);
				guildId = parsed.guildId;
				channelId = parsed.channelId;
				messageId = parsed.messageId;
			}
			if (!guildId || !channelId || !messageId) throw new Error("Discord message fetch requires guildId, channelId, and messageId (or a valid messageLink).");
			return jsonResult({
				ok: true,
				message: normalizeMessage(accountId ? await fetchMessageDiscord(channelId, messageId, { accountId }) : await fetchMessageDiscord(channelId, messageId)),
				guildId,
				channelId,
				messageId
			});
		}
		case "readMessages": {
			if (!isActionEnabled("messages")) throw new Error("Discord message reads are disabled.");
			const channelId = resolveChannelId();
			const query = {
				limit: typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : void 0,
				before: readStringParam(params, "before"),
				after: readStringParam(params, "after"),
				around: readStringParam(params, "around")
			};
			return jsonResult({
				ok: true,
				messages: (accountId ? await readMessagesDiscord(channelId, query, { accountId }) : await readMessagesDiscord(channelId, query)).map((message) => normalizeMessage(message))
			});
		}
		case "sendMessage": {
			if (!isActionEnabled("messages")) throw new Error("Discord message sends are disabled.");
			const to = readStringParam(params, "to", { required: true });
			const asVoice = params.asVoice === true;
			const silent = params.silent === true;
			const rawComponents = params.components;
			const componentSpec = rawComponents && typeof rawComponents === "object" && !Array.isArray(rawComponents) ? readDiscordComponentSpec(rawComponents) : null;
			const components = Array.isArray(rawComponents) || typeof rawComponents === "function" ? rawComponents : void 0;
			const content = readStringParam(params, "content", {
				required: !asVoice && !componentSpec && !components,
				allowEmpty: true
			});
			const mediaUrl = readStringParam(params, "mediaUrl", { trim: false }) ?? readStringParam(params, "path", { trim: false }) ?? readStringParam(params, "filePath", { trim: false });
			const filename = readStringParam(params, "filename");
			const replyTo = readStringParam(params, "replyTo");
			const rawEmbeds = params.embeds;
			const embeds = Array.isArray(rawEmbeds) ? rawEmbeds : void 0;
			const sessionKey = readStringParam(params, "__sessionKey");
			const agentId = readStringParam(params, "__agentId");
			if (componentSpec) {
				if (asVoice) throw new Error("Discord components cannot be sent as voice messages.");
				if (embeds?.length) throw new Error("Discord components cannot include embeds.");
				const normalizedContent = content?.trim() ? content : void 0;
				return jsonResult({
					ok: true,
					result: await sendDiscordComponentMessage(to, componentSpec.text ? componentSpec : {
						...componentSpec,
						text: normalizedContent
					}, {
						...cfgOptions,
						...accountId ? { accountId } : {},
						silent,
						replyTo: replyTo ?? void 0,
						sessionKey: sessionKey ?? void 0,
						agentId: agentId ?? void 0,
						mediaUrl: mediaUrl ?? void 0,
						filename: filename ?? void 0
					}),
					components: true
				});
			}
			if (asVoice) {
				if (!mediaUrl) throw new Error("Voice messages require a media file reference (mediaUrl, path, or filePath).");
				if (content && content.trim()) throw new Error("Voice messages cannot include text content (Discord limitation). Remove the content parameter.");
				assertMediaNotDataUrl(mediaUrl);
				return jsonResult({
					ok: true,
					result: await sendVoiceMessageDiscord(to, mediaUrl, {
						...cfgOptions,
						...accountId ? { accountId } : {},
						replyTo,
						silent
					}),
					voiceMessage: true
				});
			}
			return jsonResult({
				ok: true,
				result: await sendMessageDiscord(to, content ?? "", {
					...cfgOptions,
					...accountId ? { accountId } : {},
					mediaUrl,
					mediaLocalRoots: options?.mediaLocalRoots,
					replyTo,
					components,
					embeds,
					silent
				})
			});
		}
		case "editMessage": {
			if (!isActionEnabled("messages")) throw new Error("Discord message edits are disabled.");
			const channelId = resolveChannelId();
			const messageId = readStringParam(params, "messageId", { required: true });
			const content = readStringParam(params, "content", { required: true });
			return jsonResult({
				ok: true,
				message: accountId ? await editMessageDiscord(channelId, messageId, { content }, { accountId }) : await editMessageDiscord(channelId, messageId, { content })
			});
		}
		case "deleteMessage": {
			if (!isActionEnabled("messages")) throw new Error("Discord message deletes are disabled.");
			const channelId = resolveChannelId();
			const messageId = readStringParam(params, "messageId", { required: true });
			if (accountId) await deleteMessageDiscord(channelId, messageId, { accountId });
			else await deleteMessageDiscord(channelId, messageId);
			return jsonResult({ ok: true });
		}
		case "threadCreate": {
			if (!isActionEnabled("threads")) throw new Error("Discord threads are disabled.");
			const channelId = resolveChannelId();
			const name = readStringParam(params, "name", { required: true });
			const messageId = readStringParam(params, "messageId");
			const content = readStringParam(params, "content");
			const autoArchiveMinutesRaw = params.autoArchiveMinutes;
			const payload = {
				name,
				messageId,
				autoArchiveMinutes: typeof autoArchiveMinutesRaw === "number" && Number.isFinite(autoArchiveMinutesRaw) ? autoArchiveMinutesRaw : void 0,
				content,
				appliedTags: readStringArrayParam(params, "appliedTags") ?? void 0
			};
			return jsonResult({
				ok: true,
				thread: accountId ? await createThreadDiscord(channelId, payload, { accountId }) : await createThreadDiscord(channelId, payload)
			});
		}
		case "threadList": {
			if (!isActionEnabled("threads")) throw new Error("Discord threads are disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const channelId = readStringParam(params, "channelId");
			const includeArchived = typeof params.includeArchived === "boolean" ? params.includeArchived : void 0;
			const before = readStringParam(params, "before");
			const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : void 0;
			return jsonResult({
				ok: true,
				threads: accountId ? await listThreadsDiscord({
					guildId,
					channelId,
					includeArchived,
					before,
					limit
				}, { accountId }) : await listThreadsDiscord({
					guildId,
					channelId,
					includeArchived,
					before,
					limit
				})
			});
		}
		case "threadReply": {
			if (!isActionEnabled("threads")) throw new Error("Discord threads are disabled.");
			const channelId = resolveChannelId();
			const content = readStringParam(params, "content", { required: true });
			const mediaUrl = readStringParam(params, "mediaUrl");
			const replyTo = readStringParam(params, "replyTo");
			return jsonResult({
				ok: true,
				result: await sendMessageDiscord(`channel:${channelId}`, content, {
					...cfgOptions,
					...accountId ? { accountId } : {},
					mediaUrl,
					mediaLocalRoots: options?.mediaLocalRoots,
					replyTo
				})
			});
		}
		case "pinMessage": {
			if (!isActionEnabled("pins")) throw new Error("Discord pins are disabled.");
			const channelId = resolveChannelId();
			const messageId = readStringParam(params, "messageId", { required: true });
			if (accountId) await pinMessageDiscord(channelId, messageId, { accountId });
			else await pinMessageDiscord(channelId, messageId);
			return jsonResult({ ok: true });
		}
		case "unpinMessage": {
			if (!isActionEnabled("pins")) throw new Error("Discord pins are disabled.");
			const channelId = resolveChannelId();
			const messageId = readStringParam(params, "messageId", { required: true });
			if (accountId) await unpinMessageDiscord(channelId, messageId, { accountId });
			else await unpinMessageDiscord(channelId, messageId);
			return jsonResult({ ok: true });
		}
		case "listPins": {
			if (!isActionEnabled("pins")) throw new Error("Discord pins are disabled.");
			const channelId = resolveChannelId();
			return jsonResult({
				ok: true,
				pins: (accountId ? await listPinsDiscord(channelId, { accountId }) : await listPinsDiscord(channelId)).map((pin) => normalizeMessage(pin))
			});
		}
		case "searchMessages": {
			if (!isActionEnabled("search")) throw new Error("Discord search is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const content = readStringParam(params, "content", { required: true });
			const channelId = readStringParam(params, "channelId");
			const channelIds = readStringArrayParam(params, "channelIds");
			const authorId = readStringParam(params, "authorId");
			const authorIds = readStringArrayParam(params, "authorIds");
			const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : void 0;
			const channelIdList = [...channelIds ?? [], ...channelId ? [channelId] : []];
			const authorIdList = [...authorIds ?? [], ...authorId ? [authorId] : []];
			const results = accountId ? await searchMessagesDiscord({
				guildId,
				content,
				channelIds: channelIdList.length ? channelIdList : void 0,
				authorIds: authorIdList.length ? authorIdList : void 0,
				limit
			}, { accountId }) : await searchMessagesDiscord({
				guildId,
				content,
				channelIds: channelIdList.length ? channelIdList : void 0,
				authorIds: authorIdList.length ? authorIdList : void 0,
				limit
			});
			if (!results || typeof results !== "object") return jsonResult({
				ok: true,
				results
			});
			const resultsRecord = results;
			const messages = resultsRecord.messages;
			const normalizedMessages = Array.isArray(messages) ? messages.map((group) => Array.isArray(group) ? group.map((msg) => normalizeMessage(msg)) : group) : messages;
			return jsonResult({
				ok: true,
				results: {
					...resultsRecord,
					messages: normalizedMessages
				}
			});
		}
		default: throw new Error(`Unknown action: ${action}`);
	}
}

//#endregion
//#region src/agents/tools/discord-actions-moderation-shared.ts
const moderationPermissions = {
	timeout: PermissionFlagsBits.ModerateMembers,
	kick: PermissionFlagsBits.KickMembers,
	ban: PermissionFlagsBits.BanMembers
};
function isDiscordModerationAction(action) {
	return action === "timeout" || action === "kick" || action === "ban";
}
function requiredGuildPermissionForModerationAction(action) {
	return moderationPermissions[action];
}
function readDiscordModerationCommand(action, params) {
	if (!isDiscordModerationAction(action)) throw new Error(`Unsupported Discord moderation action: ${action}`);
	return {
		action,
		guildId: readStringParam(params, "guildId", { required: true }),
		userId: readStringParam(params, "userId", { required: true }),
		durationMinutes: readNumberParam(params, "durationMinutes", { integer: true }),
		until: readStringParam(params, "until"),
		reason: readStringParam(params, "reason"),
		deleteMessageDays: readNumberParam(params, "deleteMessageDays", { integer: true })
	};
}

//#endregion
//#region src/agents/tools/discord-actions-moderation.ts
async function verifySenderModerationPermission(params) {
	if (!params.senderUserId) return;
	if (!await hasAnyGuildPermissionDiscord(params.guildId, params.senderUserId, [params.requiredPermission], params.accountId ? { accountId: params.accountId } : void 0)) throw new Error("Sender does not have required permissions for this moderation action.");
}
async function handleDiscordModerationAction(action, params, isActionEnabled) {
	if (!isDiscordModerationAction(action)) throw new Error(`Unknown action: ${action}`);
	if (!isActionEnabled("moderation", false)) throw new Error("Discord moderation is disabled.");
	const command = readDiscordModerationCommand(action, params);
	const accountId = readStringParam(params, "accountId");
	const senderUserId = readStringParam(params, "senderUserId");
	await verifySenderModerationPermission({
		guildId: command.guildId,
		senderUserId,
		requiredPermission: requiredGuildPermissionForModerationAction(command.action),
		accountId
	});
	switch (command.action) {
		case "timeout": return jsonResult({
			ok: true,
			member: accountId ? await timeoutMemberDiscord({
				guildId: command.guildId,
				userId: command.userId,
				durationMinutes: command.durationMinutes,
				until: command.until,
				reason: command.reason
			}, { accountId }) : await timeoutMemberDiscord({
				guildId: command.guildId,
				userId: command.userId,
				durationMinutes: command.durationMinutes,
				until: command.until,
				reason: command.reason
			})
		});
		case "kick":
			if (accountId) await kickMemberDiscord({
				guildId: command.guildId,
				userId: command.userId,
				reason: command.reason
			}, { accountId });
			else await kickMemberDiscord({
				guildId: command.guildId,
				userId: command.userId,
				reason: command.reason
			});
			return jsonResult({ ok: true });
		case "ban":
			if (accountId) await banMemberDiscord({
				guildId: command.guildId,
				userId: command.userId,
				reason: command.reason,
				deleteMessageDays: command.deleteMessageDays
			}, { accountId });
			else await banMemberDiscord({
				guildId: command.guildId,
				userId: command.userId,
				reason: command.reason,
				deleteMessageDays: command.deleteMessageDays
			});
			return jsonResult({ ok: true });
	}
}

//#endregion
//#region src/discord/monitor/gateway-registry.ts
/**
* Module-level registry of active Discord GatewayPlugin instances.
* Bridges the gap between agent tool handlers (which only have REST access)
* and the gateway WebSocket (needed for operations like updatePresence).
* Follows the same pattern as presence-cache.ts.
*/
const gatewayRegistry = /* @__PURE__ */ new Map();
const DEFAULT_ACCOUNT_KEY = "\0__default__";
function resolveAccountKey(accountId) {
	return accountId ?? DEFAULT_ACCOUNT_KEY;
}
/** Get the GatewayPlugin for an account. Returns undefined if not registered. */
function getGateway(accountId) {
	return gatewayRegistry.get(resolveAccountKey(accountId));
}

//#endregion
//#region src/agents/tools/discord-actions-presence.ts
const ACTIVITY_TYPE_MAP = {
	playing: 0,
	streaming: 1,
	listening: 2,
	watching: 3,
	custom: 4,
	competing: 5
};
const VALID_STATUSES = new Set([
	"online",
	"dnd",
	"idle",
	"invisible"
]);
async function handleDiscordPresenceAction(action, params, isActionEnabled) {
	if (action !== "setPresence") throw new Error(`Unknown presence action: ${action}`);
	if (!isActionEnabled("presence", false)) throw new Error("Discord presence changes are disabled.");
	const accountId = readStringParam(params, "accountId");
	const gateway = getGateway(accountId);
	if (!gateway) throw new Error(`Discord gateway not available${accountId ? ` for account "${accountId}"` : ""}. The bot may not be connected.`);
	if (!gateway.isConnected) throw new Error(`Discord gateway is not connected${accountId ? ` for account "${accountId}"` : ""}.`);
	const statusRaw = readStringParam(params, "status") ?? "online";
	if (!VALID_STATUSES.has(statusRaw)) throw new Error(`Invalid status "${statusRaw}". Must be one of: ${[...VALID_STATUSES].join(", ")}`);
	const status = statusRaw;
	const activityTypeRaw = readStringParam(params, "activityType");
	const activityName = readStringParam(params, "activityName");
	const activities = [];
	if (activityTypeRaw || activityName) {
		if (!activityTypeRaw) throw new Error(`activityType is required when activityName is provided. Valid types: ${Object.keys(ACTIVITY_TYPE_MAP).join(", ")}`);
		const typeNum = ACTIVITY_TYPE_MAP[activityTypeRaw.toLowerCase()];
		if (typeNum === void 0) throw new Error(`Invalid activityType "${activityTypeRaw}". Must be one of: ${Object.keys(ACTIVITY_TYPE_MAP).join(", ")}`);
		const activity = {
			name: activityName ?? "",
			type: typeNum
		};
		if (typeNum === 1) {
			const url = readStringParam(params, "activityUrl");
			if (url) activity.url = url;
		}
		const state = readStringParam(params, "activityState");
		if (state) activity.state = state;
		activities.push(activity);
	}
	const presenceData = {
		since: null,
		activities,
		status,
		afk: false
	};
	gateway.updatePresence(presenceData);
	return jsonResult({
		ok: true,
		status,
		activities: activities.map((a) => ({
			type: a.type,
			name: a.name,
			...a.url ? { url: a.url } : {},
			...a.state ? { state: a.state } : {}
		}))
	});
}

//#endregion
//#region src/agents/tools/discord-actions.ts
const messagingActions = new Set([
	"react",
	"reactions",
	"sticker",
	"poll",
	"permissions",
	"fetchMessage",
	"readMessages",
	"sendMessage",
	"editMessage",
	"deleteMessage",
	"threadCreate",
	"threadList",
	"threadReply",
	"pinMessage",
	"unpinMessage",
	"listPins",
	"searchMessages"
]);
const guildActions = new Set([
	"memberInfo",
	"roleInfo",
	"emojiList",
	"emojiUpload",
	"stickerUpload",
	"roleAdd",
	"roleRemove",
	"channelInfo",
	"channelList",
	"voiceStatus",
	"eventList",
	"eventCreate",
	"channelCreate",
	"channelEdit",
	"channelDelete",
	"channelMove",
	"categoryCreate",
	"categoryEdit",
	"categoryDelete",
	"channelPermissionSet",
	"channelPermissionRemove"
]);
const moderationActions = new Set([
	"timeout",
	"kick",
	"ban"
]);
const presenceActions = new Set(["setPresence"]);
async function handleDiscordAction(params, cfg, options) {
	const action = readStringParam(params, "action", { required: true });
	const isActionEnabled = createDiscordActionGate({
		cfg,
		accountId: readStringParam(params, "accountId")
	});
	if (messagingActions.has(action)) return await handleDiscordMessagingAction(action, params, isActionEnabled, options, cfg);
	if (guildActions.has(action)) return await handleDiscordGuildAction(action, params, isActionEnabled);
	if (moderationActions.has(action)) return await handleDiscordModerationAction(action, params, isActionEnabled);
	if (presenceActions.has(action)) return await handleDiscordPresenceAction(action, params, isActionEnabled);
	throw new Error(`Unknown action: ${action}`);
}

//#endregion
//#region src/channels/plugins/actions/discord/handle-action.guild-admin.ts
async function tryHandleDiscordMessageActionGuildAdmin(params) {
	const { ctx, resolveChannelId, readParentIdParam } = params;
	const { action, params: actionParams, cfg } = ctx;
	const accountId = ctx.accountId ?? readStringParam(actionParams, "accountId");
	if (action === "member-info") {
		const userId = readStringParam(actionParams, "userId", { required: true });
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		return await handleDiscordAction({
			action: "memberInfo",
			accountId: accountId ?? void 0,
			guildId,
			userId
		}, cfg);
	}
	if (action === "role-info") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		return await handleDiscordAction({
			action: "roleInfo",
			accountId: accountId ?? void 0,
			guildId
		}, cfg);
	}
	if (action === "emoji-list") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		return await handleDiscordAction({
			action: "emojiList",
			accountId: accountId ?? void 0,
			guildId
		}, cfg);
	}
	if (action === "emoji-upload") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const name = readStringParam(actionParams, "emojiName", { required: true });
		const mediaUrl = readStringParam(actionParams, "media", {
			required: true,
			trim: false
		});
		const roleIds = readStringArrayParam(actionParams, "roleIds");
		return await handleDiscordAction({
			action: "emojiUpload",
			accountId: accountId ?? void 0,
			guildId,
			name,
			mediaUrl,
			roleIds
		}, cfg);
	}
	if (action === "sticker-upload") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const name = readStringParam(actionParams, "stickerName", { required: true });
		const description = readStringParam(actionParams, "stickerDesc", { required: true });
		const tags = readStringParam(actionParams, "stickerTags", { required: true });
		const mediaUrl = readStringParam(actionParams, "media", {
			required: true,
			trim: false
		});
		return await handleDiscordAction({
			action: "stickerUpload",
			accountId: accountId ?? void 0,
			guildId,
			name,
			description,
			tags,
			mediaUrl
		}, cfg);
	}
	if (action === "role-add" || action === "role-remove") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const userId = readStringParam(actionParams, "userId", { required: true });
		const roleId = readStringParam(actionParams, "roleId", { required: true });
		return await handleDiscordAction({
			action: action === "role-add" ? "roleAdd" : "roleRemove",
			accountId: accountId ?? void 0,
			guildId,
			userId,
			roleId
		}, cfg);
	}
	if (action === "channel-info") {
		const channelId = readStringParam(actionParams, "channelId", { required: true });
		return await handleDiscordAction({
			action: "channelInfo",
			accountId: accountId ?? void 0,
			channelId
		}, cfg);
	}
	if (action === "channel-list") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		return await handleDiscordAction({
			action: "channelList",
			accountId: accountId ?? void 0,
			guildId
		}, cfg);
	}
	if (action === "channel-create") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const name = readStringParam(actionParams, "name", { required: true });
		const type = readNumberParam(actionParams, "type", { integer: true });
		const parentId = readParentIdParam(actionParams);
		const topic = readStringParam(actionParams, "topic");
		const position = readNumberParam(actionParams, "position", { integer: true });
		const nsfw = typeof actionParams.nsfw === "boolean" ? actionParams.nsfw : void 0;
		return await handleDiscordAction({
			action: "channelCreate",
			accountId: accountId ?? void 0,
			guildId,
			name,
			type: type ?? void 0,
			parentId: parentId ?? void 0,
			topic: topic ?? void 0,
			position: position ?? void 0,
			nsfw
		}, cfg);
	}
	if (action === "channel-edit") {
		const channelId = readStringParam(actionParams, "channelId", { required: true });
		const name = readStringParam(actionParams, "name");
		const topic = readStringParam(actionParams, "topic");
		const position = readNumberParam(actionParams, "position", { integer: true });
		const parentId = readParentIdParam(actionParams);
		const nsfw = typeof actionParams.nsfw === "boolean" ? actionParams.nsfw : void 0;
		const rateLimitPerUser = readNumberParam(actionParams, "rateLimitPerUser", { integer: true });
		const archived = typeof actionParams.archived === "boolean" ? actionParams.archived : void 0;
		const locked = typeof actionParams.locked === "boolean" ? actionParams.locked : void 0;
		const autoArchiveDuration = readNumberParam(actionParams, "autoArchiveDuration", { integer: true });
		const availableTags = parseAvailableTags(actionParams.availableTags);
		return await handleDiscordAction({
			action: "channelEdit",
			accountId: accountId ?? void 0,
			channelId,
			name: name ?? void 0,
			topic: topic ?? void 0,
			position: position ?? void 0,
			parentId: parentId === void 0 ? void 0 : parentId,
			nsfw,
			rateLimitPerUser: rateLimitPerUser ?? void 0,
			archived,
			locked,
			autoArchiveDuration: autoArchiveDuration ?? void 0,
			availableTags
		}, cfg);
	}
	if (action === "channel-delete") {
		const channelId = readStringParam(actionParams, "channelId", { required: true });
		return await handleDiscordAction({
			action: "channelDelete",
			accountId: accountId ?? void 0,
			channelId
		}, cfg);
	}
	if (action === "channel-move") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const channelId = readStringParam(actionParams, "channelId", { required: true });
		const parentId = readParentIdParam(actionParams);
		const position = readNumberParam(actionParams, "position", { integer: true });
		return await handleDiscordAction({
			action: "channelMove",
			accountId: accountId ?? void 0,
			guildId,
			channelId,
			parentId: parentId === void 0 ? void 0 : parentId,
			position: position ?? void 0
		}, cfg);
	}
	if (action === "category-create") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const name = readStringParam(actionParams, "name", { required: true });
		const position = readNumberParam(actionParams, "position", { integer: true });
		return await handleDiscordAction({
			action: "categoryCreate",
			accountId: accountId ?? void 0,
			guildId,
			name,
			position: position ?? void 0
		}, cfg);
	}
	if (action === "category-edit") {
		const categoryId = readStringParam(actionParams, "categoryId", { required: true });
		const name = readStringParam(actionParams, "name");
		const position = readNumberParam(actionParams, "position", { integer: true });
		return await handleDiscordAction({
			action: "categoryEdit",
			accountId: accountId ?? void 0,
			categoryId,
			name: name ?? void 0,
			position: position ?? void 0
		}, cfg);
	}
	if (action === "category-delete") {
		const categoryId = readStringParam(actionParams, "categoryId", { required: true });
		return await handleDiscordAction({
			action: "categoryDelete",
			accountId: accountId ?? void 0,
			categoryId
		}, cfg);
	}
	if (action === "voice-status") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const userId = readStringParam(actionParams, "userId", { required: true });
		return await handleDiscordAction({
			action: "voiceStatus",
			accountId: accountId ?? void 0,
			guildId,
			userId
		}, cfg);
	}
	if (action === "event-list") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		return await handleDiscordAction({
			action: "eventList",
			accountId: accountId ?? void 0,
			guildId
		}, cfg);
	}
	if (action === "event-create") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const name = readStringParam(actionParams, "eventName", { required: true });
		const startTime = readStringParam(actionParams, "startTime", { required: true });
		const endTime = readStringParam(actionParams, "endTime");
		const description = readStringParam(actionParams, "desc");
		const channelId = readStringParam(actionParams, "channelId");
		const location = readStringParam(actionParams, "location");
		const entityType = readStringParam(actionParams, "eventType");
		return await handleDiscordAction({
			action: "eventCreate",
			accountId: accountId ?? void 0,
			guildId,
			name,
			startTime,
			endTime,
			description,
			channelId,
			location,
			entityType
		}, cfg);
	}
	if (isDiscordModerationAction(action)) {
		const moderation = readDiscordModerationCommand(action, {
			...actionParams,
			durationMinutes: readNumberParam(actionParams, "durationMin", { integer: true }),
			deleteMessageDays: readNumberParam(actionParams, "deleteDays", { integer: true })
		});
		const senderUserId = ctx.requesterSenderId?.trim() || void 0;
		return await handleDiscordAction({
			action: moderation.action,
			accountId: accountId ?? void 0,
			guildId: moderation.guildId,
			userId: moderation.userId,
			durationMinutes: moderation.durationMinutes,
			until: moderation.until,
			reason: moderation.reason,
			deleteMessageDays: moderation.deleteMessageDays,
			senderUserId
		}, cfg);
	}
	if (action === "thread-list") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const channelId = readStringParam(actionParams, "channelId");
		const includeArchived = typeof actionParams.includeArchived === "boolean" ? actionParams.includeArchived : void 0;
		const before = readStringParam(actionParams, "before");
		const limit = readNumberParam(actionParams, "limit", { integer: true });
		return await handleDiscordAction({
			action: "threadList",
			accountId: accountId ?? void 0,
			guildId,
			channelId,
			includeArchived,
			before,
			limit
		}, cfg);
	}
	if (action === "thread-reply") {
		const content = readStringParam(actionParams, "message", { required: true });
		const mediaUrl = readStringParam(actionParams, "media", { trim: false });
		const replyTo = readStringParam(actionParams, "replyTo");
		const channelId = readStringParam(actionParams, "threadId") ?? resolveChannelId();
		return await handleDiscordAction({
			action: "threadReply",
			accountId: accountId ?? void 0,
			channelId,
			content,
			mediaUrl: mediaUrl ?? void 0,
			replyTo: replyTo ?? void 0
		}, cfg);
	}
	if (action === "search") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const query = readStringParam(actionParams, "query", { required: true });
		return await handleDiscordAction({
			action: "searchMessages",
			accountId: accountId ?? void 0,
			guildId,
			content: query,
			channelId: readStringParam(actionParams, "channelId"),
			channelIds: readStringArrayParam(actionParams, "channelIds"),
			authorId: readStringParam(actionParams, "authorId"),
			authorIds: readStringArrayParam(actionParams, "authorIds"),
			limit: readNumberParam(actionParams, "limit", { integer: true })
		}, cfg);
	}
}

//#endregion
//#region src/channels/plugins/actions/discord/handle-action.ts
const providerId = "discord";
async function handleDiscordMessageAction(ctx) {
	const { action, params, cfg } = ctx;
	const accountId = ctx.accountId ?? readStringParam(params, "accountId");
	const actionOptions = { mediaLocalRoots: ctx.mediaLocalRoots };
	const resolveChannelId = () => resolveDiscordChannelId(readStringParam(params, "channelId") ?? readStringParam(params, "to", { required: true }));
	if (action === "send") {
		const to = readStringParam(params, "to", { required: true });
		const asVoice = params.asVoice === true;
		const rawComponents = params.components;
		const hasComponents = Boolean(rawComponents) && (typeof rawComponents === "function" || typeof rawComponents === "object");
		const components = hasComponents ? rawComponents : void 0;
		const content = readStringParam(params, "message", {
			required: !asVoice && !hasComponents,
			allowEmpty: true
		});
		const mediaUrl = readStringParam(params, "media", { trim: false }) ?? readStringParam(params, "path", { trim: false }) ?? readStringParam(params, "filePath", { trim: false });
		const filename = readStringParam(params, "filename");
		const replyTo = readStringParam(params, "replyTo");
		const rawEmbeds = params.embeds;
		const embeds = Array.isArray(rawEmbeds) ? rawEmbeds : void 0;
		const silent = params.silent === true;
		const sessionKey = readStringParam(params, "__sessionKey");
		const agentId = readStringParam(params, "__agentId");
		return await handleDiscordAction({
			action: "sendMessage",
			accountId: accountId ?? void 0,
			to,
			content,
			mediaUrl: mediaUrl ?? void 0,
			filename: filename ?? void 0,
			replyTo: replyTo ?? void 0,
			components,
			embeds,
			asVoice,
			silent,
			__sessionKey: sessionKey ?? void 0,
			__agentId: agentId ?? void 0
		}, cfg, actionOptions);
	}
	if (action === "poll") {
		const to = readStringParam(params, "to", { required: true });
		const question = readStringParam(params, "pollQuestion", { required: true });
		const answers = readStringArrayParam(params, "pollOption", { required: true }) ?? [];
		const allowMultiselect = typeof params.pollMulti === "boolean" ? params.pollMulti : void 0;
		const durationHours = readNumberParam(params, "pollDurationHours", { integer: true });
		return await handleDiscordAction({
			action: "poll",
			accountId: accountId ?? void 0,
			to,
			question,
			answers,
			allowMultiselect,
			durationHours: durationHours ?? void 0,
			content: readStringParam(params, "message")
		}, cfg, actionOptions);
	}
	if (action === "react") {
		const messageIdRaw = resolveReactionMessageId({
			args: params,
			toolContext: ctx.toolContext
		});
		const messageId = messageIdRaw != null ? String(messageIdRaw).trim() : "";
		if (!messageId) throw new Error("messageId required. Provide messageId explicitly or react to the current inbound message.");
		const emoji = readStringParam(params, "emoji", { allowEmpty: true });
		const remove = typeof params.remove === "boolean" ? params.remove : void 0;
		return await handleDiscordAction({
			action: "react",
			accountId: accountId ?? void 0,
			channelId: resolveChannelId(),
			messageId,
			emoji,
			remove
		}, cfg, actionOptions);
	}
	if (action === "reactions") {
		const messageId = readStringParam(params, "messageId", { required: true });
		const limit = readNumberParam(params, "limit", { integer: true });
		return await handleDiscordAction({
			action: "reactions",
			accountId: accountId ?? void 0,
			channelId: resolveChannelId(),
			messageId,
			limit
		}, cfg, actionOptions);
	}
	if (action === "read") {
		const limit = readNumberParam(params, "limit", { integer: true });
		return await handleDiscordAction({
			action: "readMessages",
			accountId: accountId ?? void 0,
			channelId: resolveChannelId(),
			limit,
			before: readStringParam(params, "before"),
			after: readStringParam(params, "after"),
			around: readStringParam(params, "around")
		}, cfg, actionOptions);
	}
	if (action === "edit") {
		const messageId = readStringParam(params, "messageId", { required: true });
		const content = readStringParam(params, "message", { required: true });
		return await handleDiscordAction({
			action: "editMessage",
			accountId: accountId ?? void 0,
			channelId: resolveChannelId(),
			messageId,
			content
		}, cfg, actionOptions);
	}
	if (action === "delete") {
		const messageId = readStringParam(params, "messageId", { required: true });
		return await handleDiscordAction({
			action: "deleteMessage",
			accountId: accountId ?? void 0,
			channelId: resolveChannelId(),
			messageId
		}, cfg, actionOptions);
	}
	if (action === "pin" || action === "unpin" || action === "list-pins") {
		const messageId = action === "list-pins" ? void 0 : readStringParam(params, "messageId", { required: true });
		return await handleDiscordAction({
			action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
			accountId: accountId ?? void 0,
			channelId: resolveChannelId(),
			messageId
		}, cfg, actionOptions);
	}
	if (action === "permissions") return await handleDiscordAction({
		action: "permissions",
		accountId: accountId ?? void 0,
		channelId: resolveChannelId()
	}, cfg, actionOptions);
	if (action === "thread-create") {
		const name = readStringParam(params, "threadName", { required: true });
		const messageId = readStringParam(params, "messageId");
		const content = readStringParam(params, "message");
		const autoArchiveMinutes = readNumberParam(params, "autoArchiveMin", { integer: true });
		const appliedTags = readStringArrayParam(params, "appliedTags");
		return await handleDiscordAction({
			action: "threadCreate",
			accountId: accountId ?? void 0,
			channelId: resolveChannelId(),
			name,
			messageId,
			content,
			autoArchiveMinutes,
			appliedTags: appliedTags ?? void 0
		}, cfg, actionOptions);
	}
	if (action === "sticker") {
		const stickerIds = readStringArrayParam(params, "stickerId", {
			required: true,
			label: "sticker-id"
		}) ?? [];
		return await handleDiscordAction({
			action: "sticker",
			accountId: accountId ?? void 0,
			to: readStringParam(params, "to", { required: true }),
			stickerIds,
			content: readStringParam(params, "message")
		}, cfg, actionOptions);
	}
	if (action === "set-presence") return await handleDiscordAction({
		action: "setPresence",
		accountId: accountId ?? void 0,
		status: readStringParam(params, "status"),
		activityType: readStringParam(params, "activityType"),
		activityName: readStringParam(params, "activityName"),
		activityUrl: readStringParam(params, "activityUrl"),
		activityState: readStringParam(params, "activityState")
	}, cfg, actionOptions);
	const adminResult = await tryHandleDiscordMessageActionGuildAdmin({
		ctx,
		resolveChannelId,
		readParentIdParam: readDiscordParentIdParam
	});
	if (adminResult !== void 0) return adminResult;
	throw new Error(`Action ${String(action)} is not supported for provider ${providerId}.`);
}

//#endregion
//#region src/channels/plugins/actions/discord.ts
const discordMessageActions = {
	listActions: ({ cfg }) => {
		const accounts = listTokenSourcedAccounts(listEnabledDiscordAccounts(cfg));
		if (accounts.length === 0) return [];
		const gate = createUnionActionGate(accounts, (account) => createDiscordActionGate({
			cfg,
			accountId: account.accountId
		}));
		const isEnabled = (key, defaultValue = true) => gate(key, defaultValue);
		const actions = new Set(["send"]);
		if (isEnabled("polls")) actions.add("poll");
		if (isEnabled("reactions")) {
			actions.add("react");
			actions.add("reactions");
		}
		if (isEnabled("messages")) {
			actions.add("read");
			actions.add("edit");
			actions.add("delete");
		}
		if (isEnabled("pins")) {
			actions.add("pin");
			actions.add("unpin");
			actions.add("list-pins");
		}
		if (isEnabled("permissions")) actions.add("permissions");
		if (isEnabled("threads")) {
			actions.add("thread-create");
			actions.add("thread-list");
			actions.add("thread-reply");
		}
		if (isEnabled("search")) actions.add("search");
		if (isEnabled("stickers")) actions.add("sticker");
		if (isEnabled("memberInfo")) actions.add("member-info");
		if (isEnabled("roleInfo")) actions.add("role-info");
		if (isEnabled("reactions")) actions.add("emoji-list");
		if (isEnabled("emojiUploads")) actions.add("emoji-upload");
		if (isEnabled("stickerUploads")) actions.add("sticker-upload");
		if (isEnabled("roles", false)) {
			actions.add("role-add");
			actions.add("role-remove");
		}
		if (isEnabled("channelInfo")) {
			actions.add("channel-info");
			actions.add("channel-list");
		}
		if (isEnabled("channels")) {
			actions.add("channel-create");
			actions.add("channel-edit");
			actions.add("channel-delete");
			actions.add("channel-move");
			actions.add("category-create");
			actions.add("category-edit");
			actions.add("category-delete");
		}
		if (isEnabled("voiceStatus")) actions.add("voice-status");
		if (isEnabled("events")) {
			actions.add("event-list");
			actions.add("event-create");
		}
		if (isEnabled("moderation", false)) {
			actions.add("timeout");
			actions.add("kick");
			actions.add("ban");
		}
		if (isEnabled("presence", false)) actions.add("set-presence");
		return Array.from(actions);
	},
	extractToolSend: ({ args }) => {
		const action = typeof args.action === "string" ? args.action.trim() : "";
		if (action === "sendMessage") {
			const to = typeof args.to === "string" ? args.to : void 0;
			return to ? { to } : null;
		}
		if (action === "threadReply") {
			const channelId = typeof args.channelId === "string" ? args.channelId.trim() : "";
			return channelId ? { to: `channel:${channelId}` } : null;
		}
		return null;
	},
	handleAction: async ({ action, params, cfg, accountId, requesterSenderId, toolContext, mediaLocalRoots }) => {
		return await handleDiscordMessageAction({
			action,
			params,
			cfg,
			accountId,
			requesterSenderId,
			toolContext,
			mediaLocalRoots
		});
	}
};

//#endregion
export { discordMessageActions };