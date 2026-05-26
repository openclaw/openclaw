import { o as __toESM } from "./chunk-CNf5ZN-e.js";
import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { c as readErrorName, i as formatErrorMessage, r as extractErrorCode, t as collectErrorGraphCandidates } from "./errors-b3ZrCRlt.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { t as danger } from "./globals-YU5FjfZK.js";
import { r as extensionForMime } from "./mime-DppuT-pZ.js";
import { h as resolveTextChunksWithFallback } from "./reply-payload-DMPQsrQC.js";
import { t as loadWebMedia } from "./web-media-GlH39bZn.js";
import { n as normalizePollInput, t as normalizePollDurationHours } from "./polls-C-v11_tu.js";
import { r as makeProxyFetch } from "./proxy-fetch-B02LTFkt.js";
import { t as buildOutboundMediaLoadOptions } from "./load-options-LnfEFXDj.js";
import "./error-runtime-DGHc7DZw.js";
import "./fetch-runtime-BTAr6cKn.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./routing-79DRZvfm.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DWa7yCpn.js";
import "./web-media-Q6WLwwDo.js";
import { r as createRateLimitRetryRunner } from "./retry-policy-C4ndkoIo.js";
import "./media-runtime-BheBFFxc.js";
import "./retry-runtime-BLxc3H40.js";
import { t as normalizeDiscordToken } from "./token-CyE3_lif.js";
import { a as mergeDiscordAccountConfig, s as resolveDiscordAccount } from "./accounts-DIRzXd2H.js";
import { $ as createChannelMessage, Ht as MessageFlags$1, It as ChannelType$1, J as createUserDmChannel, St as getGuildMember, Wt as PermissionFlagsBits$1, Y as getCurrentUser, at as getChannel, h as RateLimitError, p as RequestClient, qt as require_v10, u as Embed, w as serializePayload, xt as getGuild } from "./discord-Cn5UmvYW.js";
import { t as chunkDiscordTextWithMode } from "./chunk-CixrDxH0.js";
import { t as parseAndResolveDiscordTarget } from "./target-resolver-UkwzZqMU.js";
import { isIP } from "node:net";
//#region node_modules/discord-api-types/payloads/v10/index.mjs
var import_v10 = /* @__PURE__ */ __toESM(require_v10(), 1);
import_v10.default.APIApplicationCommandPermissionsConstant;
import_v10.default.ActivityFlags;
import_v10.default.ActivityLocationKind;
import_v10.default.ActivityPlatform;
import_v10.default.ActivityType;
import_v10.default.AllowedMentionsTypes;
import_v10.default.ApplicationCommandOptionType;
import_v10.default.ApplicationCommandPermissionType;
import_v10.default.ApplicationCommandType;
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
import_v10.default.ButtonStyle;
import_v10.default.ChannelFlags;
import_v10.default.ChannelType;
import_v10.default.ComponentType;
import_v10.default.ConnectionService;
import_v10.default.ConnectionVisibility;
import_v10.default.EmbedFlags;
import_v10.default.EmbedMediaFlags;
import_v10.default.EmbedType;
import_v10.default.EntitlementType;
import_v10.default.EntryPointCommandHandlerType;
import_v10.default.ForumLayoutType;
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
import_v10.default.IntegrationExpireBehavior;
import_v10.default.InteractionContextType;
import_v10.default.InteractionResponseType;
import_v10.default.InteractionType;
import_v10.default.InviteFlags;
import_v10.default.InviteTargetType;
import_v10.default.InviteType;
import_v10.default.MembershipScreeningFieldType;
import_v10.default.MessageActivityType;
import_v10.default.MessageFlags;
import_v10.default.MessageReferenceType;
import_v10.default.MessageSearchAuthorType;
import_v10.default.MessageSearchEmbedType;
import_v10.default.MessageSearchHasType;
import_v10.default.MessageSearchSortMode;
import_v10.default.MessageType;
import_v10.default.NameplatePalette;
import_v10.default.OAuth2Scopes;
import_v10.default.OverwriteType;
import_v10.default.PermissionFlagsBits;
const PollLayoutType = import_v10.default.PollLayoutType;
import_v10.default.PresenceUpdateStatus;
import_v10.default.RoleFlags;
import_v10.default.SKUFlags;
import_v10.default.SKUType;
import_v10.default.SelectMenuDefaultValueType;
import_v10.default.SeparatorSpacingSize;
import_v10.default.SortOrderType;
import_v10.default.StageInstancePrivacyLevel;
import_v10.default.StatusDisplayType;
import_v10.default.StickerFormatType;
import_v10.default.StickerType;
import_v10.default.SubscriptionStatus;
import_v10.default.TeamMemberMembershipState;
import_v10.default.TeamMemberRole;
import_v10.default.TextInputStyle;
import_v10.default.ThreadAutoArchiveDuration;
import_v10.default.ThreadMemberFlags;
import_v10.default.UnfurledMediaItemFlags;
import_v10.default.UnfurledMediaItemLoadingState;
import_v10.default.UserFlags;
import_v10.default.UserPremiumType;
import_v10.default.VideoQualityMode;
import_v10.default.WebhookType;
//#endregion
//#region extensions/discord/src/proxy-fetch.ts
function resolveDiscordProxyUrl(account, cfg) {
	const accountProxy = account.config.proxy?.trim();
	if (accountProxy) return accountProxy;
	const channelProxy = cfg?.channels?.discord?.proxy;
	if (typeof channelProxy !== "string") return;
	return channelProxy.trim() || void 0;
}
function resolveDiscordProxyFetchByUrl(proxyUrl, runtime) {
	return withValidatedDiscordProxy(proxyUrl, runtime, (proxy) => makeProxyFetch(proxy));
}
function resolveDiscordProxyFetchForAccount(account, cfg, runtime) {
	return resolveDiscordProxyFetchByUrl(resolveDiscordProxyUrl(account, cfg), runtime);
}
function withValidatedDiscordProxy(proxyUrl, runtime, createValue) {
	const proxy = proxyUrl?.trim();
	if (!proxy) return;
	try {
		validateDiscordProxyUrl(proxy);
		return createValue(proxy);
	} catch (err) {
		runtime?.error?.(danger(`discord: invalid rest proxy: ${String(err)}`));
		return;
	}
}
function validateDiscordProxyUrl(proxyUrl) {
	let parsed;
	try {
		parsed = new URL(proxyUrl);
	} catch {
		throw new Error("Proxy URL must be a valid http or https URL");
	}
	if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Proxy URL must use http or https");
	if (!isLoopbackProxyHostname(parsed.hostname)) throw new Error("Proxy URL must target a loopback host");
	return proxyUrl;
}
function isLoopbackProxyHostname(hostname) {
	const normalized = normalizeLowercaseStringOrEmpty(hostname);
	if (!normalized) return false;
	const bracketless = normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
	if (bracketless === "localhost") return true;
	const ipFamily = isIP(bracketless);
	if (ipFamily === 4) return bracketless.startsWith("127.");
	if (ipFamily === 6) return bracketless === "::1" || bracketless === "0:0:0:0:0:0:0:1";
	return false;
}
//#endregion
//#region extensions/discord/src/proxy-request-client.ts
const DISCORD_REST_TIMEOUT_MS = 15e3;
function createDiscordRequestClient(token, options) {
	if (!options?.fetch) return new RequestClient(token, options);
	return new RequestClient(token, {
		runtimeProfile: "persistent",
		maxQueueSize: 1e3,
		timeout: DISCORD_REST_TIMEOUT_MS,
		...options,
		fetch: options.fetch
	});
}
//#endregion
//#region extensions/discord/src/retry.ts
const DISCORD_RETRY_DEFAULTS = {
	attempts: 3,
	minDelayMs: 500,
	maxDelayMs: 3e4,
	jitter: .1
};
const DISCORD_RETRYABLE_STATUS_CODES = new Set([408, 429]);
const DISCORD_RETRYABLE_ERROR_CODES = new Set([
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET"
]);
const DISCORD_TRANSIENT_MESSAGE_RE = /\b(?:bad gateway|fetch failed|network error|networkerror|service unavailable|socket hang up|temporarily unavailable|timed out|timeout)\b|connection (?:closed|reset|refused)/i;
function readDiscordErrorStatus(err) {
	if (!err || typeof err !== "object") return;
	const raw = "status" in err && err.status !== void 0 ? err.status : "statusCode" in err && err.statusCode !== void 0 ? err.statusCode : void 0;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
}
function isRetryableDiscordTransientError(err) {
	if (err instanceof RateLimitError) return true;
	for (const candidate of collectErrorGraphCandidates(err, (current) => [current.cause, current.error])) {
		const status = readDiscordErrorStatus(candidate);
		if (status !== void 0 && (DISCORD_RETRYABLE_STATUS_CODES.has(status) || status >= 500)) return true;
		const code = extractErrorCode(candidate);
		if (code && DISCORD_RETRYABLE_ERROR_CODES.has(code.toUpperCase())) return true;
		if (readErrorName(candidate) === "AbortError") return true;
		if ((candidate instanceof Error || candidate !== null && typeof candidate === "object") && DISCORD_TRANSIENT_MESSAGE_RE.test(formatErrorMessage(candidate))) return true;
	}
	return false;
}
function createDiscordRetryRunner(params) {
	return createRateLimitRetryRunner({
		...params,
		defaults: DISCORD_RETRY_DEFAULTS,
		logLabel: "discord",
		shouldRetry: isRetryableDiscordTransientError,
		retryAfterMs: (err) => err instanceof RateLimitError ? err.retryAfter * 1e3 : void 0
	});
}
//#endregion
//#region extensions/discord/src/client.ts
function createDiscordRuntimeAccountContext(params) {
	return {
		cfg: params.cfg,
		accountId: normalizeAccountId(params.accountId)
	};
}
function resolveDiscordClientAccountContext(opts, runtime) {
	const resolvedCfg = requireRuntimeConfig(opts.cfg, "Discord client");
	const account = resolveAccountWithoutToken({
		cfg: resolvedCfg,
		accountId: opts.accountId
	});
	return {
		cfg: resolvedCfg,
		account,
		proxyFetch: resolveDiscordProxyFetchForAccount(account, resolvedCfg, runtime)
	};
}
function resolveToken(params) {
	const fallback = normalizeDiscordToken(params.fallbackToken, "channels.discord.token");
	if (!fallback) {
		if (params.account.tokenStatus === "configured_unavailable") throw new Error(`Discord bot token configured for account "${params.accountId}" is unavailable; resolve SecretRefs against the active runtime snapshot before using this account.`);
		throw new Error(`Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`);
	}
	return fallback;
}
function resolveRest(token, account, cfg, rest, proxyFetch) {
	if (rest) return rest;
	const resolvedProxyFetch = proxyFetch ?? resolveDiscordProxyFetchForAccount(account, cfg);
	return createDiscordRequestClient(token, resolvedProxyFetch ? { fetch: resolvedProxyFetch } : void 0);
}
function resolveAccountWithoutToken(params) {
	const accountId = normalizeAccountId(params.accountId);
	const merged = mergeDiscordAccountConfig(params.cfg, accountId);
	const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
	const accountEnabled = merged.enabled !== false;
	return {
		accountId,
		enabled: baseEnabled && accountEnabled,
		name: normalizeOptionalString(merged.name),
		token: "",
		tokenSource: "none",
		tokenStatus: "missing",
		config: merged
	};
}
function createDiscordRestClient(opts) {
	const explicitToken = normalizeDiscordToken(opts.token, "channels.discord.token");
	const proxyContext = resolveDiscordClientAccountContext(opts);
	const resolvedCfg = proxyContext.cfg;
	const account = explicitToken ? proxyContext.account : resolveDiscordAccount({
		cfg: resolvedCfg,
		accountId: opts.accountId
	});
	const token = explicitToken ?? resolveToken({
		account,
		accountId: account.accountId,
		fallbackToken: account.token
	});
	return {
		token,
		rest: resolveRest(token, account, resolvedCfg, opts.rest, proxyContext.proxyFetch),
		account
	};
}
function createDiscordClient(opts) {
	const { token, rest, account } = createDiscordRestClient(opts);
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
//#region extensions/discord/src/recipient-resolution.ts
async function parseAndResolveRecipient(raw, cfg, accountId, parseOptions = {}) {
	if (!cfg) throw new Error("Discord recipient resolution requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.");
	const resolvedCfg = requireRuntimeConfig(cfg, "Discord recipient resolution");
	const resolved = await parseAndResolveDiscordTarget(raw, {
		cfg: resolvedCfg,
		accountId: resolveDiscordAccount({
			cfg: resolvedCfg,
			accountId
		}).accountId
	}, parseOptions);
	return {
		kind: resolved.kind,
		id: resolved.id
	};
}
//#endregion
//#region extensions/discord/src/send.permissions.ts
const PERMISSION_ENTRIES = Object.entries(PermissionFlagsBits$1).filter(([, value]) => typeof value === "bigint");
const ALL_PERMISSIONS = PERMISSION_ENTRIES.reduce((acc, [, value]) => acc | value, 0n);
const ADMINISTRATOR_BIT = PermissionFlagsBits$1.Administrator;
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
	return channelType === ChannelType$1.GuildNewsThread || channelType === ChannelType$1.GuildPublicThread || channelType === ChannelType$1.GuildPrivateThread;
}
async function fetchBotUserId(rest) {
	const me = await getCurrentUser(rest);
	if (!me?.id) throw new Error("Failed to resolve bot user id");
	return me.id;
}
function resolveMemberGuildPermissionBits(params) {
	const rolesById = new Map((params.guild.roles ?? []).map((role) => [role.id, role]));
	const everyoneRole = rolesById.get(params.guild.id);
	let permissions = 0n;
	if (everyoneRole?.permissions) permissions = addPermissionBits(permissions, everyoneRole.permissions);
	for (const roleId of params.member.roles ?? []) {
		const role = rolesById.get(roleId);
		if (role?.permissions) permissions = addPermissionBits(permissions, role.permissions);
	}
	return permissions;
}
function resolveMemberChannelPermissionBits(params) {
	let permissions = resolveMemberGuildPermissionBits({
		guild: params.guild,
		member: params.member
	});
	if (hasAdministrator(permissions)) return ALL_PERMISSIONS;
	const overwrites = "permission_overwrites" in params.channel ? params.channel.permission_overwrites ?? [] : [];
	for (const overwrite of overwrites) if (overwrite.id === params.guildId) {
		permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
		permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
	}
	let roleDeny = 0n;
	let roleAllow = 0n;
	for (const overwrite of overwrites) if (params.member.roles?.includes(overwrite.id)) {
		roleDeny = addPermissionBits(roleDeny, overwrite.deny ?? "0");
		roleAllow = addPermissionBits(roleAllow, overwrite.allow ?? "0");
	}
	permissions = permissions & ~roleDeny;
	permissions = permissions | roleAllow;
	for (const overwrite of overwrites) if (overwrite.id === params.userId) {
		permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
		permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
	}
	return permissions;
}
/**
* Fetch guild-level permissions for a user. This does not include channel-specific overwrites.
*/
async function fetchMemberGuildPermissionsDiscord(guildId, userId, opts) {
	const rest = resolveDiscordRest(opts);
	try {
		const [guild, member] = await Promise.all([getGuild(rest, guildId), getGuildMember(rest, guildId, userId)]);
		return resolveMemberGuildPermissionBits({
			guild,
			member
		});
	} catch {
		return null;
	}
}
async function canViewDiscordGuildChannel(guildId, channelId, userId, opts) {
	const rest = resolveDiscordRest(opts);
	try {
		const channel = await getChannel(rest, channelId);
		if (("guild_id" in channel ? channel.guild_id : void 0) !== guildId) return false;
		const [guild, member] = await Promise.all([getGuild(rest, guildId), getGuildMember(rest, guildId, userId)]);
		return hasPermissionBit(resolveMemberChannelPermissionBits({
			guildId,
			userId,
			guild,
			member,
			channel
		}), PermissionFlagsBits$1.ViewChannel);
	} catch {
		return false;
	}
}
/**
* Returns true when the user has ADMINISTRATOR or required permission bits
* matching the provided predicate.
*/
async function hasGuildPermissionsDiscord(guildId, userId, requiredPermissions, check, opts) {
	const permissions = await fetchMemberGuildPermissionsDiscord(guildId, userId, opts);
	if (permissions === null) return false;
	if (hasAdministrator(permissions)) return true;
	return check(permissions, requiredPermissions);
}
/**
* Returns true when the user has ADMINISTRATOR or any required permission bit.
*/
async function hasAnyGuildPermissionDiscord(guildId, userId, requiredPermissions, opts) {
	return await hasGuildPermissionsDiscord(guildId, userId, requiredPermissions, (permissions, required) => required.some((permission) => hasPermissionBit(permissions, permission)), opts);
}
/**
* Returns true when the user has ADMINISTRATOR or all required permission bits.
*/
async function hasAllGuildPermissionsDiscord(guildId, userId, requiredPermissions, opts) {
	return await hasGuildPermissionsDiscord(guildId, userId, requiredPermissions, (permissions, required) => required.every((permission) => hasPermissionBit(permissions, permission)), opts);
}
async function fetchChannelPermissionsDiscord(channelId, opts) {
	const rest = resolveDiscordRest(opts);
	const channel = await getChannel(rest, channelId);
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
	const [guild, member] = await Promise.all([getGuild(rest, guildId), getGuildMember(rest, guildId, botId)]);
	const permissions = resolveMemberChannelPermissionBits({
		guildId,
		userId: botId,
		guild,
		member,
		channel
	});
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
//#region extensions/discord/src/send.types.ts
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
const DISCORD_MAX_EVENT_COVER_BYTES = 8 * 1024 * 1024;
//#endregion
//#region extensions/discord/src/send.message-request.ts
const SUPPRESS_EMBEDS_FLAG = MessageFlags$1.SuppressEmbeds;
const SUPPRESS_NOTIFICATIONS_FLAG = MessageFlags$1.SuppressNotifications;
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
function resolveDiscordMessageFlags(params) {
	let flags = 0;
	if (params.suppressEmbeds) flags |= SUPPRESS_EMBEDS_FLAG;
	if (params.silent) flags |= SUPPRESS_NOTIFICATIONS_FLAG;
	return flags || void 0;
}
function buildDiscordMessageRequest(params) {
	return stripUndefinedFields({
		...serializePayload(buildDiscordMessagePayload(params)),
		...params.replyTo ? { message_reference: {
			message_id: params.replyTo,
			fail_if_not_exists: false
		} } : {}
	});
}
function stripUndefinedFields(value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0));
}
function hasV2Components(components) {
	return Boolean(components?.some((component) => "isV2" in component && component.isV2));
}
//#endregion
//#region extensions/discord/src/send.shared.ts
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
function getDiscordErrorStatus(err) {
	if (!err || typeof err !== "object") return;
	const candidate = "status" in err && err.status !== void 0 ? err.status : "statusCode" in err && err.statusCode !== void 0 ? err.statusCode : void 0;
	if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
	if (typeof candidate === "string" && /^\d+$/.test(candidate)) return Number(candidate);
}
async function buildDiscordSendError(err, ctx) {
	if (err instanceof DiscordSendError) return err;
	const code = getDiscordErrorCode(err);
	if (code === DISCORD_CANNOT_DM) return new DiscordSendError(`discord dm failed: user blocks dms or privacy settings disallow it (code=${code})`, {
		kind: "dm-blocked",
		discordCode: code,
		status: getDiscordErrorStatus(err)
	});
	if (code !== DISCORD_MISSING_PERMISSIONS) return err;
	let missing = [];
	let probedChannelType;
	try {
		const permissions = await fetchChannelPermissionsDiscord(ctx.channelId, {
			rest: ctx.rest,
			token: ctx.token,
			cfg: ctx.cfg
		});
		probedChannelType = permissions.channelType;
		const current = new Set(permissions.permissions);
		const required = ["ViewChannel", "SendMessages"];
		if (isThreadChannelType(probedChannelType)) required.push("SendMessagesInThreads");
		if (ctx.hasMedia) required.push("AttachFiles");
		missing = required.filter((permission) => !current.has(permission));
	} catch {}
	const status = getDiscordErrorStatus(err);
	const apiDetails = [`code=${code}`, status != null ? `status=${status}` : void 0].filter(Boolean).join(" ");
	const probedPermissions = ["ViewChannel", "SendMessages"];
	if (isThreadChannelType(probedChannelType)) probedPermissions.push("SendMessagesInThreads");
	if (ctx.hasMedia) probedPermissions.push("AttachFiles");
	const probeSummary = probedPermissions.join("/");
	return new DiscordSendError(`${missing.length ? `discord missing permissions in channel ${ctx.channelId}: ${missing.join(", ")}` : `discord missing permissions in channel ${ctx.channelId}; permission probe did not identify missing ${probeSummary}`} (${apiDetails}). bot might be blocked by channel/thread overrides, archived thread state, reply target visibility, or app-role position`, {
		kind: "missing-permissions",
		channelId: ctx.channelId,
		missingPermissions: missing,
		discordCode: code,
		status
	});
}
async function resolveChannelId(rest, recipient, request) {
	if (recipient.kind === "channel") return { channelId: recipient.id };
	const dmChannel = await request(() => createUserDmChannel(rest, recipient.id), "dm-channel");
	if (!dmChannel?.id) throw new Error("Failed to create Discord DM channel");
	return {
		channelId: dmChannel.id,
		dm: true
	};
}
async function resolveDiscordTargetChannelId(raw, opts) {
	const recipient = await parseAndResolveRecipient(raw, requireRuntimeConfig(opts.cfg, "Discord target channel resolution"), opts.accountId, { defaultKind: "channel" });
	const { rest, request } = createDiscordClient(opts);
	return await resolveChannelId(rest, recipient, request);
}
async function resolveDiscordChannelType(rest, channelId) {
	try {
		return (await getChannel(rest, channelId))?.type;
	} catch {
		return;
	}
}
function buildDiscordTextChunks(text, opts = {}) {
	if (!text) return [];
	return resolveTextChunksWithFallback(text, chunkDiscordTextWithMode(text, {
		maxChars: opts.maxChars ?? DISCORD_TEXT_LIMIT,
		maxLines: opts.maxLinesPerMessage,
		chunkMode: opts.chunkMode
	}));
}
function toDiscordFileBlob(data) {
	if (data instanceof Blob) return data;
	const arrayBuffer = new ArrayBuffer(data.byteLength);
	new Uint8Array(arrayBuffer).set(data);
	return new Blob([arrayBuffer]);
}
async function sendDiscordText(rest, channelId, text, replyTo, request, maxLinesPerMessage, components, embeds, chunkMode, silent, suppressEmbeds, maxChars) {
	if (!text.trim()) throw new Error("Message must be non-empty for Discord sends");
	const chunks = buildDiscordTextChunks(text, {
		maxLinesPerMessage,
		chunkMode,
		maxChars
	});
	const sendChunk = async (chunk, isFirst) => {
		const chunkComponents = resolveDiscordSendComponents({
			components,
			text: chunk,
			isFirst
		});
		const chunkEmbeds = resolveDiscordSendEmbeds({
			embeds,
			isFirst
		});
		const body = buildDiscordMessageRequest({
			text: chunk,
			components: chunkComponents,
			embeds: chunkEmbeds,
			flags: resolveDiscordMessageFlags({
				silent,
				suppressEmbeds: suppressEmbeds && !chunkEmbeds?.length
			}),
			replyTo
		});
		return await request(() => createChannelMessage(rest, channelId, { body }), "text");
	};
	if (chunks.length === 1) {
		const result = await sendChunk(chunks[0], true);
		return {
			...result,
			platformMessageIds: result.id ? [result.id] : []
		};
	}
	const platformMessageIds = [];
	let last = null;
	for (const [index, chunk] of chunks.entries()) {
		last = await sendChunk(chunk, index === 0);
		if (last.id) platformMessageIds.push(last.id);
	}
	if (!last) throw new Error("Discord send failed (empty chunk result)");
	return {
		...last,
		platformMessageIds
	};
}
async function sendDiscordMedia(rest, channelId, text, mediaUrl, filename, mediaAccess, mediaLocalRoots, mediaReadFile, maxBytes, replyTo, request, maxLinesPerMessage, components, embeds, chunkMode, silent, suppressEmbeds, maxChars) {
	const media = await loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions({
		maxBytes,
		mediaAccess,
		mediaLocalRoots,
		mediaReadFile
	}));
	const resolvedFileName = filename?.trim() || media.fileName || (media.contentType ? `upload${extensionForMime(media.contentType) ?? ""}` : "") || "upload";
	const chunks = text ? buildDiscordTextChunks(text, {
		maxLinesPerMessage,
		chunkMode,
		maxChars
	}) : [];
	const caption = chunks[0] ?? "";
	const fileData = toDiscordFileBlob(media.buffer);
	const captionComponents = resolveDiscordSendComponents({
		components,
		text: caption,
		isFirst: true
	});
	const captionEmbeds = resolveDiscordSendEmbeds({
		embeds,
		isFirst: true
	});
	const body = buildDiscordMessageRequest({
		text: caption,
		components: captionComponents,
		embeds: captionEmbeds,
		flags: resolveDiscordMessageFlags({
			silent,
			suppressEmbeds: suppressEmbeds && !captionEmbeds?.length
		}),
		replyTo,
		files: [{
			data: fileData,
			name: resolvedFileName
		}]
	});
	const res = await request(() => createChannelMessage(rest, channelId, { body }), "media");
	const platformMessageIds = res.id ? [res.id] : [];
	for (const chunk of chunks.slice(1)) {
		if (!chunk.trim()) continue;
		const followup = await sendDiscordText(rest, channelId, chunk, replyTo, request, maxLinesPerMessage, void 0, void 0, chunkMode, silent, suppressEmbeds, maxChars);
		for (const id of followup.platformMessageIds) if (id) platformMessageIds.push(id);
	}
	return {
		...res,
		platformMessageIds
	};
}
function buildReactionIdentifier(emoji) {
	if (emoji.id && emoji.name) return `${emoji.name}:${emoji.id}`;
	return emoji.name ?? "";
}
function formatReactionEmoji(emoji) {
	return buildReactionIdentifier(emoji);
}
//#endregion
export { isThreadChannelType as A, DISCORD_MAX_STICKER_BYTES as C, fetchMemberGuildPermissionsDiscord as D, fetchChannelPermissionsDiscord as E, resolveDiscordClientAccountContext as F, resolveDiscordRest as I, DISCORD_REST_TIMEOUT_MS as L, createDiscordClient as M, createDiscordRestClient as N, hasAllGuildPermissionsDiscord as O, createDiscordRuntimeAccountContext as P, validateDiscordProxyUrl as R, DISCORD_MAX_EVENT_COVER_BYTES as S, canViewDiscordGuildChannel as T, resolveDiscordMessageFlags as _, normalizeDiscordPollInput as a, stripUndefinedFields as b, normalizeStickerIds as c, resolveDiscordTargetChannelId as d, sendDiscordMedia as f, buildDiscordMessageRequest as g, SUPPRESS_NOTIFICATIONS_FLAG as h, formatReactionEmoji as i, parseAndResolveRecipient as j, hasAnyGuildPermissionDiscord as k, resolveChannelId as l, toDiscordFileBlob as m, buildDiscordTextChunks as n, normalizeEmojiName as o, sendDiscordText as p, buildReactionIdentifier as r, normalizeReactionEmoji as s, buildDiscordSendError as t, resolveDiscordChannelType as u, resolveDiscordSendComponents as v, DiscordSendError as w, DISCORD_MAX_EMOJI_BYTES as x, resolveDiscordSendEmbeds as y, withValidatedDiscordProxy as z };
