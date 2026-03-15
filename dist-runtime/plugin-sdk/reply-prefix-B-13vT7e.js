import { g as normalizeAccountId } from "./session-key-CbP51u9x.js";
import { en as buildMessagingTarget, j as getChannelPlugin, nn as parseMentionPrefixOrAtUserTarget, rn as requireTargetKind, tn as ensureTargetId } from "./runtime-DRRlb-lt.js";
import { d as normalizeE164, s as formatTerminalLink } from "./utils-C9epF7GR.js";
import { i as buildAccountScopedDmSecurityPolicy, n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "./config-helpers-C9J9Kf27.js";
import { j as normalizeStringEntries, r as resolveAgentConfig } from "./agent-scope-BAdJcjtf.js";
//#region src/whatsapp/normalize.ts
const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const WHATSAPP_LID_RE = /^(\d+)@lid$/i;
function stripWhatsAppTargetPrefixes(value) {
	let candidate = value.trim();
	for (;;) {
		const before = candidate;
		candidate = candidate.replace(/^whatsapp:/i, "").trim();
		if (candidate === before) {return candidate;}
	}
}
function isWhatsAppGroupJid(value) {
	const candidate = stripWhatsAppTargetPrefixes(value);
	if (!candidate.toLowerCase().endsWith("@g.us")) {return false;}
	const localPart = candidate.slice(0, candidate.length - 5);
	if (!localPart || localPart.includes("@")) {return false;}
	return /^[0-9]+(-[0-9]+)*$/.test(localPart);
}
/**
* Check if value looks like a WhatsApp user target (e.g. "41796666864:0@s.whatsapp.net" or "123@lid").
*/
function isWhatsAppUserTarget(value) {
	const candidate = stripWhatsAppTargetPrefixes(value);
	return WHATSAPP_USER_JID_RE.test(candidate) || WHATSAPP_LID_RE.test(candidate);
}
/**
* Extract the phone number from a WhatsApp user JID.
* "41796666864:0@s.whatsapp.net" -> "41796666864"
* "123456@lid" -> "123456"
*/
function extractUserJidPhone(jid) {
	const userMatch = jid.match(WHATSAPP_USER_JID_RE);
	if (userMatch) {return userMatch[1];}
	const lidMatch = jid.match(WHATSAPP_LID_RE);
	if (lidMatch) {return lidMatch[1];}
	return null;
}
function normalizeWhatsAppTarget(value) {
	const candidate = stripWhatsAppTargetPrefixes(value);
	if (!candidate) {return null;}
	if (isWhatsAppGroupJid(candidate)) {return `${candidate.slice(0, candidate.length - 5)}@g.us`;}
	if (isWhatsAppUserTarget(candidate)) {
		const phone = extractUserJidPhone(candidate);
		if (!phone) {return null;}
		const normalized = normalizeE164(phone);
		return normalized.length > 1 ? normalized : null;
	}
	if (candidate.includes("@")) {return null;}
	const normalized = normalizeE164(candidate);
	return normalized.length > 1 ? normalized : null;
}
//#endregion
//#region src/channels/plugins/normalize/shared.ts
function trimMessagingTarget(raw) {
	return raw.trim() || void 0;
}
function looksLikeHandleOrPhoneTarget(params) {
	const trimmed = params.raw.trim();
	if (!trimmed) {return false;}
	if (params.prefixPattern.test(trimmed)) {return true;}
	if (trimmed.includes("@")) {return true;}
	return (params.phonePattern ?? /^\+?\d{3,}$/).test(trimmed);
}
//#endregion
//#region src/channels/plugins/normalize/whatsapp.ts
function normalizeWhatsAppAllowFromEntries(allowFrom) {
	return allowFrom.map((entry) => String(entry).trim()).filter((entry) => Boolean(entry)).map((entry) => entry === "*" ? entry : normalizeWhatsAppTarget(entry)).filter((entry) => Boolean(entry));
}
//#endregion
//#region src/plugin-sdk/channel-config-helpers.ts
/** Coerce mixed allowlist config values into plain strings without trimming or deduping. */
function mapAllowFromEntries(allowFrom) {
	return (allowFrom ?? []).map((entry) => String(entry));
}
/** Normalize user-facing allowlist entries the same way config and doctor flows expect. */
function formatTrimmedAllowFromEntries(allowFrom) {
	return normalizeStringEntries(allowFrom);
}
/** Collapse nullable config scalars into a trimmed optional string. */
function resolveOptionalConfigString(value) {
	if (value == null) {return;}
	return String(value).trim() || void 0;
}
/** Build the shared allowlist/default target adapter surface for account-scoped channel configs. */
function createScopedAccountConfigAccessors(params) {
	const base = {
		resolveAllowFrom: ({ cfg, accountId }) => mapAllowFromEntries(params.resolveAllowFrom(params.resolveAccount({
			cfg,
			accountId
		}))),
		formatAllowFrom: ({ allowFrom }) => params.formatAllowFrom(allowFrom)
	};
	if (!params.resolveDefaultTo) {return base;}
	return {
		...base,
		resolveDefaultTo: ({ cfg, accountId }) => resolveOptionalConfigString(params.resolveDefaultTo?.(params.resolveAccount({
			cfg,
			accountId
		})))
	};
}
/** Build the common CRUD/config helpers for channels that store multiple named accounts. */
function createScopedChannelConfigBase(params) {
	return {
		listAccountIds: (cfg) => params.listAccountIds(cfg),
		resolveAccount: (cfg, accountId) => params.resolveAccount(cfg, accountId),
		inspectAccount: params.inspectAccount ? (cfg, accountId) => params.inspectAccount?.(cfg, accountId) : void 0,
		defaultAccountId: (cfg) => params.defaultAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({
			cfg,
			sectionKey: params.sectionKey,
			accountId,
			enabled,
			allowTopLevel: params.allowTopLevel ?? true
		}),
		deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({
			cfg,
			sectionKey: params.sectionKey,
			accountId,
			clearBaseFields: params.clearBaseFields
		})
	};
}
/** Convert account-specific DM security fields into the shared runtime policy resolver shape. */
function createScopedDmSecurityResolver(params) {
	return ({ cfg, accountId, account }) => buildAccountScopedDmSecurityPolicy({
		cfg,
		channelKey: params.channelKey,
		accountId,
		fallbackAccountId: params.resolveFallbackAccountId?.(account) ?? account.accountId,
		policy: params.resolvePolicy(account),
		allowFrom: params.resolveAllowFrom(account) ?? [],
		defaultPolicy: params.defaultPolicy,
		allowFromPathSuffix: params.allowFromPathSuffix,
		policyPathSuffix: params.policyPathSuffix,
		approveChannelId: params.approveChannelId,
		approveHint: params.approveHint,
		normalizeEntry: params.normalizeEntry
	});
}
/** Read the effective WhatsApp allowlist through the active plugin contract. */
function resolveWhatsAppConfigAllowFrom(params) {
	const account = getChannelPlugin("whatsapp")?.config.resolveAccount(params.cfg, params.accountId);
	return account && typeof account === "object" && Array.isArray(account.allowFrom) ? account.allowFrom.map(String) : [];
}
/** Format WhatsApp allowlist entries with the same normalization used by the channel plugin. */
function formatWhatsAppConfigAllowFromEntries(allowFrom) {
	return normalizeWhatsAppAllowFromEntries(allowFrom);
}
/** Resolve the effective WhatsApp default recipient after account and root config fallback. */
function resolveWhatsAppConfigDefaultTo(params) {
	const root = params.cfg.channels?.whatsapp;
	const normalized = normalizeAccountId(params.accountId);
	return ((root?.accounts?.[normalized])?.defaultTo ?? root?.defaultTo)?.trim() || void 0;
}
/** Read iMessage allowlist entries from the active plugin's resolved account view. */
function resolveIMessageConfigAllowFrom(params) {
	const account = getChannelPlugin("imessage")?.config.resolveAccount(params.cfg, params.accountId);
	if (!account || typeof account !== "object" || !("config" in account)) {return [];}
	return mapAllowFromEntries(account.config.allowFrom);
}
/** Resolve the effective iMessage default recipient from the plugin-resolved account config. */
function resolveIMessageConfigDefaultTo(params) {
	const account = getChannelPlugin("imessage")?.config.resolveAccount(params.cfg, params.accountId);
	if (!account || typeof account !== "object" || !("config" in account)) {return;}
	return resolveOptionalConfigString(account.config.defaultTo);
}
//#endregion
//#region src/channels/read-only-account-inspect.ts
let discordInspectModulePromise;
let slackInspectModulePromise;
let telegramInspectModulePromise;
function loadDiscordInspectModule() {
	discordInspectModulePromise ??= import("./read-only-account-inspect.discord.runtime-CvvvPMx_.js");
	return discordInspectModulePromise;
}
function loadSlackInspectModule() {
	slackInspectModulePromise ??= import("./read-only-account-inspect.slack.runtime-Bv0E_tY0.js");
	return slackInspectModulePromise;
}
function loadTelegramInspectModule() {
	telegramInspectModulePromise ??= import("./read-only-account-inspect.telegram.runtime-CMF1kV0t.js");
	return telegramInspectModulePromise;
}
async function inspectReadOnlyChannelAccount(params) {
	if (params.channelId === "discord") {
		const { inspectDiscordAccount } = await loadDiscordInspectModule();
		return inspectDiscordAccount({
			cfg: params.cfg,
			accountId: params.accountId
		});
	}
	if (params.channelId === "slack") {
		const { inspectSlackAccount } = await loadSlackInspectModule();
		return inspectSlackAccount({
			cfg: params.cfg,
			accountId: params.accountId
		});
	}
	if (params.channelId === "telegram") {
		const { inspectTelegramAccount } = await loadTelegramInspectModule();
		return inspectTelegramAccount({
			cfg: params.cfg,
			accountId: params.accountId
		});
	}
	return null;
}
//#endregion
//#region src/channels/plugins/directory-config-helpers.ts
function resolveDirectoryQuery(query) {
	return query?.trim().toLowerCase() || "";
}
function resolveDirectoryLimit(limit) {
	return typeof limit === "number" && limit > 0 ? limit : void 0;
}
function applyDirectoryQueryAndLimit(ids, params) {
	const q = resolveDirectoryQuery(params.query);
	const limit = resolveDirectoryLimit(params.limit);
	const filtered = ids.filter((id) => q ? id.toLowerCase().includes(q) : true);
	return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}
function toDirectoryEntries(kind, ids) {
	return ids.map((id) => ({
		kind,
		id
	}));
}
function normalizeDirectoryIds(params) {
	return params.rawIds.map((entry) => entry.trim()).filter((entry) => Boolean(entry) && entry !== "*").map((entry) => {
		const normalized = params.normalizeId ? params.normalizeId(entry) : entry;
		return typeof normalized === "string" ? normalized.trim() : "";
	}).filter(Boolean);
}
function collectDirectoryIdsFromEntries(params) {
	return normalizeDirectoryIds({
		rawIds: (params.entries ?? []).map((entry) => String(entry)),
		normalizeId: params.normalizeId
	});
}
function collectDirectoryIdsFromMapKeys(params) {
	return normalizeDirectoryIds({
		rawIds: Object.keys(params.groups ?? {}),
		normalizeId: params.normalizeId
	});
}
function dedupeDirectoryIds(ids) {
	return Array.from(new Set(ids));
}
function listDirectoryUserEntriesFromAllowFrom(params) {
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(dedupeDirectoryIds(collectDirectoryIdsFromEntries({
		entries: params.allowFrom,
		normalizeId: params.normalizeId
	})), params));
}
function listDirectoryUserEntriesFromAllowFromAndMapKeys(params) {
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(dedupeDirectoryIds([...collectDirectoryIdsFromEntries({
		entries: params.allowFrom,
		normalizeId: params.normalizeAllowFromId
	}), ...collectDirectoryIdsFromMapKeys({
		groups: params.map,
		normalizeId: params.normalizeMapKeyId
	})]), params));
}
function listDirectoryGroupEntriesFromMapKeys(params) {
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(dedupeDirectoryIds(collectDirectoryIdsFromMapKeys({
		groups: params.groups,
		normalizeId: params.normalizeId
	})), params));
}
function listDirectoryGroupEntriesFromMapKeysAndAllowFrom(params) {
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(dedupeDirectoryIds([...collectDirectoryIdsFromMapKeys({
		groups: params.groups,
		normalizeId: params.normalizeMapKeyId
	}), ...collectDirectoryIdsFromEntries({
		entries: params.allowFrom,
		normalizeId: params.normalizeAllowFromId
	})]), params));
}
//#endregion
//#region extensions/slack/src/targets.ts
function parseSlackTarget(raw, options = {}) {
	const trimmed = raw.trim();
	if (!trimmed) {return;}
	const userTarget = parseMentionPrefixOrAtUserTarget({
		raw: trimmed,
		mentionPattern: /^<@([A-Z0-9]+)>$/i,
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
				prefix: "slack:",
				kind: "user"
			}
		],
		atUserPattern: /^[A-Z0-9]+$/i,
		atUserErrorMessage: "Slack DMs require a user id (use user:<id> or <@id>)"
	});
	if (userTarget) {return userTarget;}
	if (trimmed.startsWith("#")) {return buildMessagingTarget("channel", ensureTargetId({
		candidate: trimmed.slice(1).trim(),
		pattern: /^[A-Z0-9]+$/i,
		errorMessage: "Slack channels require a channel id (use channel:<id>)"
	}), trimmed);}
	if (options.defaultKind) {return buildMessagingTarget(options.defaultKind, trimmed, trimmed);}
	return buildMessagingTarget("channel", trimmed, trimmed);
}
function resolveSlackChannelId(raw) {
	return requireTargetKind({
		platform: "Slack",
		target: parseSlackTarget(raw, { defaultKind: "channel" }),
		kind: "channel"
	});
}
//#endregion
//#region src/channels/plugins/normalize/slack.ts
function normalizeSlackMessagingTarget(raw) {
	return parseSlackTarget(raw, { defaultKind: "channel" })?.normalized;
}
function looksLikeSlackTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) {return false;}
	if (/^<@([A-Z0-9]+)>$/i.test(trimmed)) {return true;}
	if (/^(user|channel):/i.test(trimmed)) {return true;}
	if (/^slack:/i.test(trimmed)) {return true;}
	if (/^[@#]/.test(trimmed)) {return true;}
	return /^[CUWGD][A-Z0-9]{8,}$/i.test(trimmed);
}
//#endregion
//#region src/channels/plugins/directory-config.ts
function addAllowFromAndDmsIds(ids, allowFrom, dms) {
	for (const entry of allowFrom ?? []) {
		const raw = String(entry).trim();
		if (!raw || raw === "*") {continue;}
		ids.add(raw);
	}
	addTrimmedEntries(ids, Object.keys(dms ?? {}));
}
function addTrimmedId(ids, value) {
	const trimmed = String(value).trim();
	if (trimmed) {ids.add(trimmed);}
}
function addTrimmedEntries(ids, values) {
	for (const value of values) {addTrimmedId(ids, value);}
}
function normalizeTrimmedSet(ids, normalize) {
	return Array.from(ids).map((raw) => raw.trim()).filter(Boolean).map((raw) => normalize(raw)).filter((id) => Boolean(id));
}
async function listSlackDirectoryPeersFromConfig(params) {
	const account = await inspectReadOnlyChannelAccount({
		channelId: "slack",
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account || !("config" in account)) {return [];}
	const ids = /* @__PURE__ */ new Set();
	addAllowFromAndDmsIds(ids, account.config.allowFrom ?? account.dm?.allowFrom, account.config.dms);
	for (const channel of Object.values(account.config.channels ?? {})) {addTrimmedEntries(ids, channel.users ?? []);}
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(normalizeTrimmedSet(ids, (raw) => {
		const normalizedUserId = (raw.match(/^<@([A-Z0-9]+)>$/i)?.[1] ?? raw).replace(/^(slack|user):/i, "").trim();
		if (!normalizedUserId) {return null;}
		const target = `user:${normalizedUserId}`;
		return normalizeSlackMessagingTarget(target) ?? target.toLowerCase();
	}).filter((id) => id.startsWith("user:")), params));
}
async function listSlackDirectoryGroupsFromConfig(params) {
	const account = await inspectReadOnlyChannelAccount({
		channelId: "slack",
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account || !("config" in account)) {return [];}
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(Object.keys(account.config.channels ?? {}).map((raw) => raw.trim()).filter(Boolean).map((raw) => normalizeSlackMessagingTarget(raw) ?? raw.toLowerCase()).filter((id) => id.startsWith("channel:")), params));
}
async function listDiscordDirectoryPeersFromConfig(params) {
	const account = await inspectReadOnlyChannelAccount({
		channelId: "discord",
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account || !("config" in account)) {return [];}
	const ids = /* @__PURE__ */ new Set();
	addAllowFromAndDmsIds(ids, account.config.allowFrom ?? account.config.dm?.allowFrom, account.config.dms);
	for (const guild of Object.values(account.config.guilds ?? {})) {
		addTrimmedEntries(ids, guild.users ?? []);
		for (const channel of Object.values(guild.channels ?? {})) {addTrimmedEntries(ids, channel.users ?? []);}
	}
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(normalizeTrimmedSet(ids, (raw) => {
		const cleaned = (raw.match(/^<@!?(\d+)>$/)?.[1] ?? raw).replace(/^(discord|user):/i, "").trim();
		if (!/^\d+$/.test(cleaned)) {return null;}
		return `user:${cleaned}`;
	}), params));
}
async function listDiscordDirectoryGroupsFromConfig(params) {
	const account = await inspectReadOnlyChannelAccount({
		channelId: "discord",
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account || !("config" in account)) {return [];}
	const ids = /* @__PURE__ */ new Set();
	for (const guild of Object.values(account.config.guilds ?? {})) {addTrimmedEntries(ids, Object.keys(guild.channels ?? {}));}
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(normalizeTrimmedSet(ids, (raw) => {
		const cleaned = (raw.match(/^<#(\d+)>$/)?.[1] ?? raw).replace(/^(discord|channel|group):/i, "").trim();
		if (!/^\d+$/.test(cleaned)) {return null;}
		return `channel:${cleaned}`;
	}), params));
}
async function listTelegramDirectoryPeersFromConfig(params) {
	const account = await inspectReadOnlyChannelAccount({
		channelId: "telegram",
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account || !("config" in account)) {return [];}
	const raw = [...mapAllowFromEntries(account.config.allowFrom), ...Object.keys(account.config.dms ?? {})];
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(Array.from(new Set(raw.map((entry) => entry.trim()).filter(Boolean).map((entry) => entry.replace(/^(telegram|tg):/i, "")))).map((entry) => {
		const trimmed = entry.trim();
		if (!trimmed) {return null;}
		if (/^-?\d+$/.test(trimmed)) {return trimmed;}
		return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
	}).filter((id) => Boolean(id)), params));
}
async function listTelegramDirectoryGroupsFromConfig(params) {
	const account = await inspectReadOnlyChannelAccount({
		channelId: "telegram",
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account || !("config" in account)) {return [];}
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(Object.keys(account.config.groups ?? {}).map((id) => id.trim()).filter((id) => Boolean(id) && id !== "*"), params));
}
async function listWhatsAppDirectoryPeersFromConfig(params) {
	const account = getChannelPlugin("whatsapp")?.config.resolveAccount(params.cfg, params.accountId);
	if (!account || typeof account !== "object") {return [];}
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit((account.allowFrom ?? []).map((entry) => String(entry).trim()).filter((entry) => Boolean(entry) && entry !== "*").map((entry) => normalizeWhatsAppTarget(entry) ?? "").filter(Boolean).filter((id) => !isWhatsAppGroupJid(id)), params));
}
async function listWhatsAppDirectoryGroupsFromConfig(params) {
	const account = getChannelPlugin("whatsapp")?.config.resolveAccount(params.cfg, params.accountId);
	if (!account || typeof account !== "object") {return [];}
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(Object.keys(account.groups ?? {}).map((id) => id.trim()).filter((id) => Boolean(id) && id !== "*"), params));
}
//#endregion
//#region src/terminal/links.ts
const DOCS_ROOT = "https://docs.openclaw.ai";
function formatDocsLink(path, label, opts) {
	const trimmed = path.trim();
	const url = trimmed.startsWith("http") ? trimmed : `${DOCS_ROOT}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
	return formatTerminalLink(label ?? url, url, {
		fallback: opts?.fallback ?? url,
		force: opts?.force
	});
}
//#endregion
//#region src/agents/identity.ts
const DEFAULT_ACK_REACTION = "👀";
function resolveAgentIdentity(cfg, agentId) {
	return resolveAgentConfig(cfg, agentId)?.identity;
}
function resolveAckReaction(cfg, agentId, opts) {
	if (opts?.channel && opts?.accountId) {
		const accountReaction = (getChannelConfig(cfg, opts.channel)?.accounts)?.[opts.accountId]?.ackReaction;
		if (accountReaction !== void 0) {return accountReaction.trim();}
	}
	if (opts?.channel) {
		const channelReaction = getChannelConfig(cfg, opts.channel)?.ackReaction;
		if (channelReaction !== void 0) {return channelReaction.trim();}
	}
	const configured = cfg.messages?.ackReaction;
	if (configured !== void 0) {return configured.trim();}
	return resolveAgentIdentity(cfg, agentId)?.emoji?.trim() || DEFAULT_ACK_REACTION;
}
function resolveIdentityNamePrefix(cfg, agentId) {
	const name = resolveAgentIdentity(cfg, agentId)?.name?.trim();
	if (!name) {return;}
	return `[${name}]`;
}
/** Returns just the identity name (without brackets) for template context. */
function resolveIdentityName(cfg, agentId) {
	return resolveAgentIdentity(cfg, agentId)?.name?.trim() || void 0;
}
function resolveMessagePrefix(cfg, agentId, opts) {
	const configured = opts?.configured ?? cfg.messages?.messagePrefix;
	if (configured !== void 0) {return configured;}
	if (opts?.hasAllowFrom === true) {return "";}
	return resolveIdentityNamePrefix(cfg, agentId) ?? opts?.fallback ?? "[openclaw]";
}
/** Helper to extract a channel config value by dynamic key. */
function getChannelConfig(cfg, channel) {
	const value = cfg.channels?.[channel];
	return typeof value === "object" && value !== null ? value : void 0;
}
function resolveResponsePrefix(cfg, agentId, opts) {
	if (opts?.channel && opts?.accountId) {
		const accountPrefix = (getChannelConfig(cfg, opts.channel)?.accounts)?.[opts.accountId]?.responsePrefix;
		if (accountPrefix !== void 0) {
			if (accountPrefix === "auto") {return resolveIdentityNamePrefix(cfg, agentId);}
			return accountPrefix;
		}
	}
	if (opts?.channel) {
		const channelPrefix = getChannelConfig(cfg, opts.channel)?.responsePrefix;
		if (channelPrefix !== void 0) {
			if (channelPrefix === "auto") {return resolveIdentityNamePrefix(cfg, agentId);}
			return channelPrefix;
		}
	}
	const configured = cfg.messages?.responsePrefix;
	if (configured !== void 0) {
		if (configured === "auto") {return resolveIdentityNamePrefix(cfg, agentId);}
		return configured;
	}
}
function resolveEffectiveMessagesConfig(cfg, agentId, opts) {
	return {
		messagePrefix: resolveMessagePrefix(cfg, agentId, {
			hasAllowFrom: opts?.hasAllowFrom,
			fallback: opts?.fallbackMessagePrefix
		}),
		responsePrefix: resolveResponsePrefix(cfg, agentId, {
			channel: opts?.channel,
			accountId: opts?.accountId
		})
	};
}
function resolveHumanDelayConfig(cfg, agentId) {
	const defaults = cfg.agents?.defaults?.humanDelay;
	const overrides = resolveAgentConfig(cfg, agentId)?.humanDelay;
	if (!defaults && !overrides) {return;}
	return {
		mode: overrides?.mode ?? defaults?.mode,
		minMs: overrides?.minMs ?? defaults?.minMs,
		maxMs: overrides?.maxMs ?? defaults?.maxMs
	};
}
//#endregion
//#region src/auto-reply/reply/response-prefix-template.ts
const TEMPLATE_VAR_PATTERN = /\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;
/**
* Interpolate template variables in a response prefix string.
*
* @param template - The template string with `{variable}` placeholders
* @param context - Context object with values for interpolation
* @returns The interpolated string, or undefined if template is undefined
*
* @example
* resolveResponsePrefixTemplate("[{model} | think:{thinkingLevel}]", {
*   model: "gpt-5.2",
*   thinkingLevel: "high"
* })
* // Returns: "[gpt-5.2 | think:high]"
*/
function resolveResponsePrefixTemplate(template, context) {
	if (!template) {return;}
	return template.replace(TEMPLATE_VAR_PATTERN, (match, varName) => {
		switch (varName.toLowerCase()) {
			case "model": return context.model ?? match;
			case "modelfull": return context.modelFull ?? match;
			case "provider": return context.provider ?? match;
			case "thinkinglevel":
			case "think": return context.thinkingLevel ?? match;
			case "identity.name":
			case "identityname": return context.identityName ?? match;
			default: return match;
		}
	});
}
/**
* Extract short model name from a full model string.
*
* Strips:
* - Provider prefix (e.g., "openai/" from "openai/gpt-5.2")
* - Date suffixes (e.g., "-20260205" from "claude-opus-4-6-20260205")
* - Common version suffixes (e.g., "-latest")
*
* @example
* extractShortModelName("openai-codex/gpt-5.2") // "gpt-5.2"
* extractShortModelName("claude-opus-4-6-20260205") // "claude-opus-4-6"
* extractShortModelName("gpt-5.2-latest") // "gpt-5.2"
*/
function extractShortModelName(fullModel) {
	const slash = fullModel.lastIndexOf("/");
	return (slash >= 0 ? fullModel.slice(slash + 1) : fullModel).replace(/-\d{8}$/, "").replace(/-latest$/, "");
}
//#endregion
//#region src/channels/reply-prefix.ts
function createReplyPrefixContext(params) {
	const { cfg, agentId } = params;
	const prefixContext = { identityName: resolveIdentityName(cfg, agentId) };
	const onModelSelected = (ctx) => {
		prefixContext.provider = ctx.provider;
		prefixContext.model = extractShortModelName(ctx.model);
		prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
		prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
	};
	return {
		prefixContext,
		responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId, {
			channel: params.channel,
			accountId: params.accountId
		}).responsePrefix,
		enableSlackInteractiveReplies: params.channel ? getChannelPlugin(params.channel)?.messaging?.enableInteractiveReplies?.({
			cfg,
			accountId: params.accountId
		}) ?? void 0 : void 0,
		responsePrefixContextProvider: () => prefixContext,
		onModelSelected
	};
}
function createReplyPrefixOptions(params) {
	const { responsePrefix, enableSlackInteractiveReplies, responsePrefixContextProvider, onModelSelected } = createReplyPrefixContext(params);
	return {
		responsePrefix,
		enableSlackInteractiveReplies,
		responsePrefixContextProvider,
		onModelSelected
	};
}
//#endregion
export { createScopedDmSecurityResolver as A, looksLikeHandleOrPhoneTarget as B, listDirectoryGroupEntriesFromMapKeys as C, inspectReadOnlyChannelAccount as D, listDirectoryUserEntriesFromAllowFromAndMapKeys as E, resolveIMessageConfigDefaultTo as F, isWhatsAppGroupJid as H, resolveOptionalConfigString as I, resolveWhatsAppConfigAllowFrom as L, formatWhatsAppConfigAllowFromEntries as M, mapAllowFromEntries as N, createScopedAccountConfigAccessors as O, resolveIMessageConfigAllowFrom as P, resolveWhatsAppConfigDefaultTo as R, resolveSlackChannelId as S, listDirectoryUserEntriesFromAllowFrom as T, normalizeWhatsAppTarget as U, trimMessagingTarget as V, listWhatsAppDirectoryGroupsFromConfig as _, resolveAgentIdentity as a, normalizeSlackMessagingTarget as b, resolveIdentityNamePrefix as c, listDiscordDirectoryGroupsFromConfig as d, listDiscordDirectoryPeersFromConfig as f, listTelegramDirectoryPeersFromConfig as g, listTelegramDirectoryGroupsFromConfig as h, resolveAckReaction as i, formatTrimmedAllowFromEntries as j, createScopedChannelConfigBase as k, resolveMessagePrefix as l, listSlackDirectoryPeersFromConfig as m, createReplyPrefixOptions as n, resolveEffectiveMessagesConfig as o, listSlackDirectoryGroupsFromConfig as p, resolveResponsePrefixTemplate as r, resolveHumanDelayConfig as s, createReplyPrefixContext as t, formatDocsLink as u, listWhatsAppDirectoryPeersFromConfig as v, listDirectoryGroupEntriesFromMapKeysAndAllowFrom as w, parseSlackTarget as x, looksLikeSlackTargetId as y, normalizeWhatsAppAllowFromEntries as z };
