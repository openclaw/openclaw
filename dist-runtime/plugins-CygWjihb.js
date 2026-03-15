import { m as normalizeE164 } from "./utils-Do8MzKyM.js";
import { X as getChannelPlugin, an as parseMentionPrefixOrAtUserTarget, in as ensureTargetId, on as requireTargetKind, rn as buildMessagingTarget } from "./registry-DrRO3PZ7.js";
import { n as normalizeAccountId } from "./account-id-CYKfwqh7.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { r as normalizeStringEntries } from "./string-normalization-CJJOCyGw.js";
//#region src/channels/plugins/helpers.ts
function resolveChannelDefaultAccountId(params) {
	const accountIds = params.accountIds ?? params.plugin.config.listAccountIds(params.cfg);
	return params.plugin.config.defaultAccountId?.(params.cfg) ?? accountIds[0] ?? "default";
}
function formatPairingApproveHint(channelId) {
	return `Approve via: ${formatCliCommand(`openclaw pairing list ${channelId}`)} / ${formatCliCommand(`openclaw pairing approve ${channelId} <code>`)}`;
}
function parseOptionalDelimitedEntries(value) {
	if (!value?.trim()) {return;}
	const parsed = value.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
	return parsed.length > 0 ? parsed : void 0;
}
function buildAccountScopedDmSecurityPolicy(params) {
	const resolvedAccountId = params.accountId ?? params.fallbackAccountId ?? "default";
	const channelConfig = params.cfg.channels?.[params.channelKey];
	const basePath = channelConfig?.accounts?.[resolvedAccountId] ? `channels.${params.channelKey}.accounts.${resolvedAccountId}.` : `channels.${params.channelKey}.`;
	const allowFromPath = `${basePath}${params.allowFromPathSuffix ?? ""}`;
	const policyPath = params.policyPathSuffix != null ? `${basePath}${params.policyPathSuffix}` : void 0;
	return {
		policy: params.policy ?? params.defaultPolicy ?? "pairing",
		allowFrom: params.allowFrom ?? [],
		policyPath,
		allowFromPath,
		approveHint: params.approveHint ?? formatPairingApproveHint(params.approveChannelId ?? params.channelKey),
		normalizeEntry: params.normalizeEntry
	};
}
//#endregion
//#region src/channels/plugins/config-helpers.ts
function isConfiguredSecretValue(value) {
	if (typeof value === "string") {return value.trim().length > 0;}
	return Boolean(value);
}
function setAccountEnabledInConfigSection(params) {
	const accountKey = params.accountId || "default";
	const base = params.cfg.channels?.[params.sectionKey];
	const hasAccounts = Boolean(base?.accounts);
	if (params.allowTopLevel && accountKey === "default" && !hasAccounts) {return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.sectionKey]: {
				...base,
				enabled: params.enabled
			}
		}
	};}
	const baseAccounts = base?.accounts ?? {};
	const existing = baseAccounts[accountKey] ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.sectionKey]: {
				...base,
				accounts: {
					...baseAccounts,
					[accountKey]: {
						...existing,
						enabled: params.enabled
					}
				}
			}
		}
	};
}
function deleteAccountFromConfigSection(params) {
	const accountKey = params.accountId || "default";
	const base = params.cfg.channels?.[params.sectionKey];
	if (!base) {return params.cfg;}
	const baseAccounts = base.accounts && typeof base.accounts === "object" ? { ...base.accounts } : void 0;
	if (accountKey !== "default") {
		const accounts = baseAccounts ? { ...baseAccounts } : {};
		delete accounts[accountKey];
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[params.sectionKey]: {
					...base,
					accounts: Object.keys(accounts).length ? accounts : void 0
				}
			}
		};
	}
	if (baseAccounts && Object.keys(baseAccounts).length > 0) {
		delete baseAccounts[accountKey];
		const baseRecord = { ...base };
		for (const field of params.clearBaseFields ?? []) {if (field in baseRecord) baseRecord[field] = void 0;}
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[params.sectionKey]: {
					...baseRecord,
					accounts: Object.keys(baseAccounts).length ? baseAccounts : void 0
				}
			}
		};
	}
	const nextChannels = { ...params.cfg.channels };
	delete nextChannels[params.sectionKey];
	const nextCfg = { ...params.cfg };
	if (Object.keys(nextChannels).length > 0) {nextCfg.channels = nextChannels;}
	else {delete nextCfg.channels;}
	return nextCfg;
}
function clearAccountEntryFields(params) {
	const accountKey = params.accountId || "default";
	const baseAccounts = params.accounts && typeof params.accounts === "object" ? { ...params.accounts } : void 0;
	if (!baseAccounts || !(accountKey in baseAccounts)) {return {
		nextAccounts: baseAccounts,
		changed: false,
		cleared: false
	};}
	const entry = baseAccounts[accountKey];
	if (!entry || typeof entry !== "object") {return {
		nextAccounts: baseAccounts,
		changed: false,
		cleared: false
	};}
	const nextEntry = { ...entry };
	if (!params.fields.some((field) => field in nextEntry)) {return {
		nextAccounts: baseAccounts,
		changed: false,
		cleared: false
	};}
	const isValueSet = params.isValueSet ?? isConfiguredSecretValue;
	let cleared = Boolean(params.markClearedOnFieldPresence);
	for (const field of params.fields) {
		if (!(field in nextEntry)) {continue;}
		if (isValueSet(nextEntry[field])) {cleared = true;}
		delete nextEntry[field];
	}
	if (Object.keys(nextEntry).length === 0) {delete baseAccounts[accountKey];}
	else {baseAccounts[accountKey] = nextEntry;}
	return {
		nextAccounts: Object.keys(baseAccounts).length > 0 ? baseAccounts : void 0,
		changed: true,
		cleared
	};
}
//#endregion
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
	discordInspectModulePromise ??= import("./read-only-account-inspect.discord.runtime-BDDUjDki.js");
	return discordInspectModulePromise;
}
function loadSlackInspectModule() {
	slackInspectModulePromise ??= import("./read-only-account-inspect.slack.runtime-DMsgig9J.js");
	return slackInspectModulePromise;
}
function loadTelegramInspectModule() {
	telegramInspectModulePromise ??= import("./read-only-account-inspect.telegram.runtime-CfPJBh3S.js");
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
//#region src/channels/allowlist-match.ts
function formatAllowlistMatchMeta(match) {
	return `matchKey=${match?.matchKey ?? "none"} matchSource=${match?.matchSource ?? "none"}`;
}
function compileAllowlist(entries) {
	const set = new Set(entries.filter(Boolean));
	return {
		set,
		wildcard: set.has("*")
	};
}
function compileSimpleAllowlist(entries) {
	return compileAllowlist(entries.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean));
}
function resolveAllowlistCandidates(params) {
	for (const candidate of params.candidates) {
		if (!candidate.value) {continue;}
		if (params.compiledAllowlist.set.has(candidate.value)) {return {
			allowed: true,
			matchKey: candidate.value,
			matchSource: candidate.source
		};}
	}
	return { allowed: false };
}
function resolveCompiledAllowlistMatch(params) {
	if (params.compiledAllowlist.set.size === 0) {return { allowed: false };}
	if (params.compiledAllowlist.wildcard) {return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};}
	return resolveAllowlistCandidates(params);
}
function resolveAllowlistMatchSimple(params) {
	const allowFrom = compileSimpleAllowlist(params.allowFrom);
	if (allowFrom.set.size === 0) {return { allowed: false };}
	if (allowFrom.wildcard) {return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};}
	const senderId = params.senderId.toLowerCase();
	const senderName = params.senderName?.toLowerCase();
	return resolveAllowlistCandidates({
		compiledAllowlist: allowFrom,
		candidates: [{
			value: senderId,
			source: "id"
		}, ...params.allowNameMatching === true && senderName ? [{
			value: senderName,
			source: "name"
		}] : []]
	});
}
//#endregion
export { resolveWhatsAppConfigAllowFrom as A, buildAccountScopedDmSecurityPolicy as B, createScopedChannelConfigBase as C, mapAllowFromEntries as D, formatWhatsAppConfigAllowFromEntries as E, isWhatsAppGroupJid as F, parseOptionalDelimitedEntries as H, normalizeWhatsAppTarget as I, clearAccountEntryFields as L, normalizeWhatsAppAllowFromEntries as M, looksLikeHandleOrPhoneTarget as N, resolveIMessageConfigAllowFrom as O, trimMessagingTarget as P, deleteAccountFromConfigSection as R, createScopedAccountConfigAccessors as S, formatTrimmedAllowFromEntries as T, resolveChannelDefaultAccountId as U, formatPairingApproveHint as V, listDirectoryGroupEntriesFromMapKeys as _, listDiscordDirectoryGroupsFromConfig as a, listDirectoryUserEntriesFromAllowFromAndMapKeys as b, listSlackDirectoryPeersFromConfig as c, listWhatsAppDirectoryGroupsFromConfig as d, listWhatsAppDirectoryPeersFromConfig as f, resolveSlackChannelId as g, parseSlackTarget as h, resolveCompiledAllowlistMatch as i, resolveWhatsAppConfigDefaultTo as j, resolveIMessageConfigDefaultTo as k, listTelegramDirectoryGroupsFromConfig as l, normalizeSlackMessagingTarget as m, formatAllowlistMatchMeta as n, listDiscordDirectoryPeersFromConfig as o, looksLikeSlackTargetId as p, resolveAllowlistMatchSimple as r, listSlackDirectoryGroupsFromConfig as s, compileAllowlist as t, listTelegramDirectoryPeersFromConfig as u, listDirectoryGroupEntriesFromMapKeysAndAllowFrom as v, createScopedDmSecurityResolver as w, inspectReadOnlyChannelAccount as x, listDirectoryUserEntriesFromAllowFrom as y, setAccountEnabledInConfigSection as z };
