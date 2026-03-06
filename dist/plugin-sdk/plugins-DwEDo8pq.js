import { $ as normalizeAgentId, at as DEFAULT_ACCOUNT_ID, l as resolveDefaultAgentId, ot as normalizeAccountId, st as normalizeOptionalAccountId } from "./run-with-concurrency-ZJkCGcIf.js";
import { i as resolveWhatsAppAccount, v as resolveAccountEntry, y as createAccountListHelpers } from "./accounts-CrOPd8ML.js";
import { Ct as normalizeChatChannelId, Dt as requireActivePluginRegistry, Et as getActivePluginRegistryVersion, Wr as normalizeResolvedSecretInputString, ti as isTruthyEnvValue, vt as CHAT_CHANNEL_ORDER, xt as normalizeAnyChannelId } from "./config-CF9NdNtk.js";
import { S as normalizeE164, a as createSubsystemLogger } from "./logger-PgEXMMsU.js";
import fs from "node:fs";
import util from "node:util";

//#region src/channels/chat-type.ts
function normalizeChatType(raw) {
	const value = raw?.trim().toLowerCase();
	if (!value) return;
	if (value === "direct" || value === "dm") return "direct";
	if (value === "group") return "group";
	if (value === "channel") return "channel";
}

//#endregion
//#region src/channels/plugins/account-action-gate.ts
function createAccountActionGate(params) {
	return (key, defaultValue = true) => {
		const accountValue = params.accountActions?.[key];
		if (accountValue !== void 0) return accountValue;
		const baseValue = params.baseActions?.[key];
		if (baseValue !== void 0) return baseValue;
		return defaultValue;
	};
}

//#endregion
//#region src/discord/token.ts
function normalizeDiscordToken(raw, path) {
	const trimmed = normalizeResolvedSecretInputString({
		value: raw,
		path
	});
	if (!trimmed) return;
	return trimmed.replace(/^Bot\s+/i, "");
}
function resolveDiscordToken(cfg, opts = {}) {
	const accountId = normalizeAccountId(opts.accountId);
	const discordCfg = cfg?.channels?.discord;
	const resolveAccountCfg = (id) => {
		const accounts = discordCfg?.accounts;
		if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return;
		const direct = accounts[id];
		if (direct) return direct;
		const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === id);
		return matchKey ? accounts[matchKey] : void 0;
	};
	const accountCfg = resolveAccountCfg(accountId);
	const hasAccountToken = Boolean(accountCfg && Object.prototype.hasOwnProperty.call(accountCfg, "token"));
	const accountToken = normalizeDiscordToken(accountCfg?.token ?? void 0, `channels.discord.accounts.${accountId}.token`);
	if (accountToken) return {
		token: accountToken,
		source: "config"
	};
	if (hasAccountToken) return {
		token: "",
		source: "none"
	};
	const configToken = normalizeDiscordToken(discordCfg?.token ?? void 0, "channels.discord.token");
	if (configToken) return {
		token: configToken,
		source: "config"
	};
	const envToken = accountId === DEFAULT_ACCOUNT_ID ? normalizeDiscordToken(opts.envToken ?? process.env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN") : void 0;
	if (envToken) return {
		token: envToken,
		source: "env"
	};
	return {
		token: "",
		source: "none"
	};
}

//#endregion
//#region src/discord/accounts.ts
const { listAccountIds: listAccountIds$1, resolveDefaultAccountId: resolveDefaultAccountId$1 } = createAccountListHelpers("discord");
const listDiscordAccountIds = listAccountIds$1;
const resolveDefaultDiscordAccountId = resolveDefaultAccountId$1;
function resolveAccountConfig$2(cfg, accountId) {
	return resolveAccountEntry(cfg.channels?.discord?.accounts, accountId);
}
function mergeDiscordAccountConfig(cfg, accountId) {
	const { accounts: _ignored, ...base } = cfg.channels?.discord ?? {};
	const account = resolveAccountConfig$2(cfg, accountId) ?? {};
	return {
		...base,
		...account
	};
}
function createDiscordActionGate(params) {
	const accountId = normalizeAccountId(params.accountId);
	return createAccountActionGate({
		baseActions: params.cfg.channels?.discord?.actions,
		accountActions: resolveAccountConfig$2(params.cfg, accountId)?.actions
	});
}
function resolveDiscordAccount(params) {
	const accountId = normalizeAccountId(params.accountId);
	const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
	const merged = mergeDiscordAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const tokenResolution = resolveDiscordToken(params.cfg, { accountId });
	return {
		accountId,
		enabled,
		name: merged.name?.trim() || void 0,
		token: tokenResolution.token,
		tokenSource: tokenResolution.source,
		config: merged
	};
}
function listEnabledDiscordAccounts(cfg) {
	return listDiscordAccountIds(cfg).map((accountId) => resolveDiscordAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
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
		if (candidate === before) return candidate;
	}
}
function isWhatsAppGroupJid(value) {
	const candidate = stripWhatsAppTargetPrefixes(value);
	if (!candidate.toLowerCase().endsWith("@g.us")) return false;
	const localPart = candidate.slice(0, candidate.length - 5);
	if (!localPart || localPart.includes("@")) return false;
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
	if (userMatch) return userMatch[1];
	const lidMatch = jid.match(WHATSAPP_LID_RE);
	if (lidMatch) return lidMatch[1];
	return null;
}
function normalizeWhatsAppTarget(value) {
	const candidate = stripWhatsAppTargetPrefixes(value);
	if (!candidate) return null;
	if (isWhatsAppGroupJid(candidate)) return `${candidate.slice(0, candidate.length - 5)}@g.us`;
	if (isWhatsAppUserTarget(candidate)) {
		const phone = extractUserJidPhone(candidate);
		if (!phone) return null;
		const normalized = normalizeE164(phone);
		return normalized.length > 1 ? normalized : null;
	}
	if (candidate.includes("@")) return null;
	const normalized = normalizeE164(candidate);
	return normalized.length > 1 ? normalized : null;
}

//#endregion
//#region src/slack/token.ts
function resolveSlackBotToken(raw, path = "channels.slack.botToken") {
	return normalizeResolvedSecretInputString({
		value: raw,
		path
	});
}
function resolveSlackAppToken(raw, path = "channels.slack.appToken") {
	return normalizeResolvedSecretInputString({
		value: raw,
		path
	});
}
function resolveSlackUserToken(raw, path = "channels.slack.userToken") {
	return normalizeResolvedSecretInputString({
		value: raw,
		path
	});
}

//#endregion
//#region src/slack/accounts.ts
const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("slack");
const listSlackAccountIds = listAccountIds;
const resolveDefaultSlackAccountId = resolveDefaultAccountId;
function resolveAccountConfig$1(cfg, accountId) {
	return resolveAccountEntry(cfg.channels?.slack?.accounts, accountId);
}
function mergeSlackAccountConfig(cfg, accountId) {
	const { accounts: _ignored, ...base } = cfg.channels?.slack ?? {};
	const account = resolveAccountConfig$1(cfg, accountId) ?? {};
	return {
		...base,
		...account
	};
}
function resolveSlackAccount(params) {
	const accountId = normalizeAccountId(params.accountId);
	const baseEnabled = params.cfg.channels?.slack?.enabled !== false;
	const merged = mergeSlackAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
	const envBot = allowEnv ? resolveSlackBotToken(process.env.SLACK_BOT_TOKEN) : void 0;
	const envApp = allowEnv ? resolveSlackAppToken(process.env.SLACK_APP_TOKEN) : void 0;
	const envUser = allowEnv ? resolveSlackUserToken(process.env.SLACK_USER_TOKEN) : void 0;
	const configBot = resolveSlackBotToken(merged.botToken, `channels.slack.accounts.${accountId}.botToken`);
	const configApp = resolveSlackAppToken(merged.appToken, `channels.slack.accounts.${accountId}.appToken`);
	const configUser = resolveSlackUserToken(merged.userToken, `channels.slack.accounts.${accountId}.userToken`);
	const botToken = configBot ?? envBot;
	const appToken = configApp ?? envApp;
	const userToken = configUser ?? envUser;
	const botTokenSource = configBot ? "config" : envBot ? "env" : "none";
	const appTokenSource = configApp ? "config" : envApp ? "env" : "none";
	const userTokenSource = configUser ? "config" : envUser ? "env" : "none";
	return {
		accountId,
		enabled,
		name: merged.name?.trim() || void 0,
		botToken,
		appToken,
		userToken,
		botTokenSource,
		appTokenSource,
		userTokenSource,
		config: merged,
		groupPolicy: merged.groupPolicy,
		textChunkLimit: merged.textChunkLimit,
		mediaMaxMb: merged.mediaMaxMb,
		reactionNotifications: merged.reactionNotifications,
		reactionAllowlist: merged.reactionAllowlist,
		replyToMode: merged.replyToMode,
		replyToModeByChatType: merged.replyToModeByChatType,
		actions: merged.actions,
		slashCommand: merged.slashCommand,
		dm: merged.dm,
		channels: merged.channels
	};
}
function listEnabledSlackAccounts(cfg) {
	return listSlackAccountIds(cfg).map((accountId) => resolveSlackAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}
function resolveSlackReplyToMode(account, chatType) {
	const normalized = normalizeChatType(chatType ?? void 0);
	if (normalized && account.replyToModeByChatType?.[normalized] !== void 0) return account.replyToModeByChatType[normalized] ?? "off";
	if (normalized === "direct" && account.dm?.replyToMode !== void 0) return account.dm.replyToMode;
	return account.replyToMode ?? "off";
}

//#endregion
//#region src/plugin-sdk/account-resolution.ts
function resolveAccountWithDefaultFallback(params) {
	const hasExplicitAccountId = Boolean(params.accountId?.trim());
	const normalizedAccountId = params.normalizeAccountId(params.accountId);
	const primary = params.resolvePrimary(normalizedAccountId);
	if (hasExplicitAccountId || params.hasCredential(primary)) return primary;
	const fallbackId = params.resolveDefaultAccountId();
	if (fallbackId === normalizedAccountId) return primary;
	const fallback = params.resolvePrimary(fallbackId);
	if (!params.hasCredential(fallback)) return primary;
	return fallback;
}
function listConfiguredAccountIds$1(params) {
	if (!params.accounts) return [];
	const ids = /* @__PURE__ */ new Set();
	for (const key of Object.keys(params.accounts)) {
		if (!key) continue;
		ids.add(params.normalizeAccountId(key));
	}
	return [...ids];
}

//#endregion
//#region src/config/bindings.ts
function normalizeBindingType(binding) {
	return binding.type === "acp" ? "acp" : "route";
}
function isRouteBinding(binding) {
	return normalizeBindingType(binding) === "route";
}
function isAcpBinding(binding) {
	return normalizeBindingType(binding) === "acp";
}
function listConfiguredBindings(cfg) {
	return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}
function listRouteBindings(cfg) {
	return listConfiguredBindings(cfg).filter(isRouteBinding);
}
function listAcpBindings(cfg) {
	return listConfiguredBindings(cfg).filter(isAcpBinding);
}

//#endregion
//#region src/routing/bindings.ts
function normalizeBindingChannelId(raw) {
	const normalized = normalizeChatChannelId(raw);
	if (normalized) return normalized;
	return (raw ?? "").trim().toLowerCase() || null;
}
function listBindings(cfg) {
	return listRouteBindings(cfg);
}
function resolveNormalizedBindingMatch(binding) {
	if (!binding || typeof binding !== "object") return null;
	const match = binding.match;
	if (!match || typeof match !== "object") return null;
	const channelId = normalizeBindingChannelId(match.channel);
	if (!channelId) return null;
	const accountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
	if (!accountId || accountId === "*") return null;
	return {
		agentId: normalizeAgentId(binding.agentId),
		accountId: normalizeAccountId(accountId),
		channelId
	};
}
function listBoundAccountIds(cfg, channelId) {
	const normalizedChannel = normalizeBindingChannelId(channelId);
	if (!normalizedChannel) return [];
	const ids = /* @__PURE__ */ new Set();
	for (const binding of listBindings(cfg)) {
		const resolved = resolveNormalizedBindingMatch(binding);
		if (!resolved || resolved.channelId !== normalizedChannel) continue;
		ids.add(resolved.accountId);
	}
	return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
}
function resolveDefaultAgentBoundAccountId(cfg, channelId) {
	const normalizedChannel = normalizeBindingChannelId(channelId);
	if (!normalizedChannel) return null;
	const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
	for (const binding of listBindings(cfg)) {
		const resolved = resolveNormalizedBindingMatch(binding);
		if (!resolved || resolved.channelId !== normalizedChannel || resolved.agentId !== defaultAgentId) continue;
		return resolved.accountId;
	}
	return null;
}
function buildChannelAccountBindings(cfg) {
	const map = /* @__PURE__ */ new Map();
	for (const binding of listBindings(cfg)) {
		const resolved = resolveNormalizedBindingMatch(binding);
		if (!resolved) continue;
		const byAgent = map.get(resolved.channelId) ?? /* @__PURE__ */ new Map();
		const list = byAgent.get(resolved.agentId) ?? [];
		if (!list.includes(resolved.accountId)) list.push(resolved.accountId);
		byAgent.set(resolved.agentId, list);
		map.set(resolved.channelId, byAgent);
	}
	return map;
}

//#endregion
//#region src/routing/default-account-warnings.ts
function formatChannelDefaultAccountPath(channelKey) {
	return `channels.${channelKey}.defaultAccount`;
}
function formatChannelAccountsDefaultPath(channelKey) {
	return `channels.${channelKey}.accounts.default`;
}
function formatSetExplicitDefaultInstruction(channelKey) {
	return `Set ${formatChannelDefaultAccountPath(channelKey)} or add ${formatChannelAccountsDefaultPath(channelKey)}`;
}

//#endregion
//#region src/telegram/token.ts
function resolveTelegramToken(cfg, opts = {}) {
	const accountId = normalizeAccountId(opts.accountId);
	const telegramCfg = cfg?.channels?.telegram;
	const resolveAccountCfg = (id) => {
		const accounts = telegramCfg?.accounts;
		if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return;
		const direct = accounts[id];
		if (direct) return direct;
		const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === id);
		return matchKey ? accounts[matchKey] : void 0;
	};
	const accountCfg = resolveAccountCfg(accountId !== DEFAULT_ACCOUNT_ID ? accountId : DEFAULT_ACCOUNT_ID);
	const accountTokenFile = accountCfg?.tokenFile?.trim();
	if (accountTokenFile) {
		if (!fs.existsSync(accountTokenFile)) {
			opts.logMissingFile?.(`channels.telegram.accounts.${accountId}.tokenFile not found: ${accountTokenFile}`);
			return {
				token: "",
				source: "none"
			};
		}
		try {
			const token = fs.readFileSync(accountTokenFile, "utf-8").trim();
			if (token) return {
				token,
				source: "tokenFile"
			};
		} catch (err) {
			opts.logMissingFile?.(`channels.telegram.accounts.${accountId}.tokenFile read failed: ${String(err)}`);
			return {
				token: "",
				source: "none"
			};
		}
		return {
			token: "",
			source: "none"
		};
	}
	const accountToken = normalizeResolvedSecretInputString({
		value: accountCfg?.botToken,
		path: `channels.telegram.accounts.${accountId}.botToken`
	});
	if (accountToken) return {
		token: accountToken,
		source: "config"
	};
	const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
	const tokenFile = telegramCfg?.tokenFile?.trim();
	if (tokenFile) {
		if (!fs.existsSync(tokenFile)) {
			opts.logMissingFile?.(`channels.telegram.tokenFile not found: ${tokenFile}`);
			return {
				token: "",
				source: "none"
			};
		}
		try {
			const token = fs.readFileSync(tokenFile, "utf-8").trim();
			if (token) return {
				token,
				source: "tokenFile"
			};
		} catch (err) {
			opts.logMissingFile?.(`channels.telegram.tokenFile read failed: ${String(err)}`);
			return {
				token: "",
				source: "none"
			};
		}
	}
	const configToken = normalizeResolvedSecretInputString({
		value: telegramCfg?.botToken,
		path: "channels.telegram.botToken"
	});
	if (configToken) return {
		token: configToken,
		source: "config"
	};
	const envToken = allowEnv ? (opts.envToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim() : "";
	if (envToken) return {
		token: envToken,
		source: "env"
	};
	return {
		token: "",
		source: "none"
	};
}

//#endregion
//#region src/telegram/accounts.ts
const log = createSubsystemLogger("telegram/accounts");
function formatDebugArg(value) {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? value.message;
	return util.inspect(value, {
		colors: false,
		depth: null,
		compact: true,
		breakLength: Infinity
	});
}
const debugAccounts = (...args) => {
	if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS)) {
		const parts = args.map((arg) => formatDebugArg(arg));
		log.warn(parts.join(" ").trim());
	}
};
function listConfiguredAccountIds(cfg) {
	return listConfiguredAccountIds$1({
		accounts: cfg.channels?.telegram?.accounts,
		normalizeAccountId
	});
}
function listTelegramAccountIds(cfg) {
	const ids = Array.from(new Set([...listConfiguredAccountIds(cfg), ...listBoundAccountIds(cfg, "telegram")]));
	debugAccounts("listTelegramAccountIds", ids);
	if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
	return ids.toSorted((a, b) => a.localeCompare(b));
}
let emittedMissingDefaultWarn = false;
function resolveDefaultTelegramAccountId(cfg) {
	const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "telegram");
	if (boundDefault) return boundDefault;
	const preferred = normalizeOptionalAccountId(cfg.channels?.telegram?.defaultAccount);
	if (preferred && listTelegramAccountIds(cfg).some((accountId) => normalizeAccountId(accountId) === preferred)) return preferred;
	const ids = listTelegramAccountIds(cfg);
	if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
	if (ids.length > 1 && !emittedMissingDefaultWarn) {
		emittedMissingDefaultWarn = true;
		log.warn(`channels.telegram: accounts.default is missing; falling back to "${ids[0]}". ${formatSetExplicitDefaultInstruction("telegram")} to avoid routing surprises in multi-account setups.`);
	}
	return ids[0] ?? DEFAULT_ACCOUNT_ID;
}
function resolveAccountConfig(cfg, accountId) {
	const normalized = normalizeAccountId(accountId);
	return resolveAccountEntry(cfg.channels?.telegram?.accounts, normalized);
}
function mergeTelegramAccountConfig(cfg, accountId) {
	const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, groups: channelGroups, ...base } = cfg.channels?.telegram ?? {};
	const account = resolveAccountConfig(cfg, accountId) ?? {};
	const isMultiAccount = Object.keys(cfg.channels?.telegram?.accounts ?? {}).length > 1;
	const groups = account.groups ?? (isMultiAccount ? void 0 : channelGroups);
	return {
		...base,
		...account,
		groups
	};
}
function createTelegramActionGate(params) {
	const accountId = normalizeAccountId(params.accountId);
	return createAccountActionGate({
		baseActions: params.cfg.channels?.telegram?.actions,
		accountActions: resolveAccountConfig(params.cfg, accountId)?.actions
	});
}
function resolveTelegramAccount(params) {
	const baseEnabled = params.cfg.channels?.telegram?.enabled !== false;
	const resolve = (accountId) => {
		const merged = mergeTelegramAccountConfig(params.cfg, accountId);
		const accountEnabled = merged.enabled !== false;
		const enabled = baseEnabled && accountEnabled;
		const tokenResolution = resolveTelegramToken(params.cfg, { accountId });
		debugAccounts("resolve", {
			accountId,
			enabled,
			tokenSource: tokenResolution.source
		});
		return {
			accountId,
			enabled,
			name: merged.name?.trim() || void 0,
			token: tokenResolution.token,
			tokenSource: tokenResolution.source,
			config: merged
		};
	};
	return resolveAccountWithDefaultFallback({
		accountId: params.accountId,
		normalizeAccountId,
		resolvePrimary: resolve,
		hasCredential: (account) => account.tokenSource !== "none",
		resolveDefaultAccountId: () => resolveDefaultTelegramAccountId(params.cfg)
	});
}
function listEnabledTelegramAccounts(cfg) {
	return listTelegramAccountIds(cfg).map((accountId) => resolveTelegramAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}

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
//#region src/slack/targets.ts
function parseSlackTarget(raw, options = {}) {
	const trimmed = raw.trim();
	if (!trimmed) return;
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
	if (userTarget) return userTarget;
	if (trimmed.startsWith("#")) return buildMessagingTarget("channel", ensureTargetId({
		candidate: trimmed.slice(1).trim(),
		pattern: /^[A-Z0-9]+$/i,
		errorMessage: "Slack channels require a channel id (use channel:<id>)"
	}), trimmed);
	if (options.defaultKind) return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
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
	if (!trimmed) return false;
	if (/^<@([A-Z0-9]+)>$/i.test(trimmed)) return true;
	if (/^(user|channel):/i.test(trimmed)) return true;
	if (/^slack:/i.test(trimmed)) return true;
	if (/^[@#]/.test(trimmed)) return true;
	return /^[CUWGD][A-Z0-9]{8,}$/i.test(trimmed);
}

//#endregion
//#region src/channels/plugins/directory-config.ts
function addAllowFromAndDmsIds(ids, allowFrom, dms) {
	for (const entry of allowFrom ?? []) {
		const raw = String(entry).trim();
		if (!raw || raw === "*") continue;
		ids.add(raw);
	}
	addTrimmedEntries(ids, Object.keys(dms ?? {}));
}
function addTrimmedId(ids, value) {
	const trimmed = String(value).trim();
	if (trimmed) ids.add(trimmed);
}
function addTrimmedEntries(ids, values) {
	for (const value of values) addTrimmedId(ids, value);
}
function normalizeTrimmedSet(ids, normalize) {
	return Array.from(ids).map((raw) => raw.trim()).filter(Boolean).map((raw) => normalize(raw)).filter((id) => Boolean(id));
}
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
async function listSlackDirectoryPeersFromConfig(params) {
	const account = resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const ids = /* @__PURE__ */ new Set();
	addAllowFromAndDmsIds(ids, account.config.allowFrom ?? account.dm?.allowFrom, account.config.dms);
	for (const channel of Object.values(account.config.channels ?? {})) addTrimmedEntries(ids, channel.users ?? []);
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(normalizeTrimmedSet(ids, (raw) => {
		const normalizedUserId = (raw.match(/^<@([A-Z0-9]+)>$/i)?.[1] ?? raw).replace(/^(slack|user):/i, "").trim();
		if (!normalizedUserId) return null;
		const target = `user:${normalizedUserId}`;
		return normalizeSlackMessagingTarget(target) ?? target.toLowerCase();
	}).filter((id) => id.startsWith("user:")), params));
}
async function listSlackDirectoryGroupsFromConfig(params) {
	const account = resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(Object.keys(account.config.channels ?? {}).map((raw) => raw.trim()).filter(Boolean).map((raw) => normalizeSlackMessagingTarget(raw) ?? raw.toLowerCase()).filter((id) => id.startsWith("channel:")), params));
}
async function listDiscordDirectoryPeersFromConfig(params) {
	const account = resolveDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const ids = /* @__PURE__ */ new Set();
	addAllowFromAndDmsIds(ids, account.config.allowFrom ?? account.config.dm?.allowFrom, account.config.dms);
	for (const guild of Object.values(account.config.guilds ?? {})) {
		addTrimmedEntries(ids, guild.users ?? []);
		for (const channel of Object.values(guild.channels ?? {})) addTrimmedEntries(ids, channel.users ?? []);
	}
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(normalizeTrimmedSet(ids, (raw) => {
		const cleaned = (raw.match(/^<@!?(\d+)>$/)?.[1] ?? raw).replace(/^(discord|user):/i, "").trim();
		if (!/^\d+$/.test(cleaned)) return null;
		return `user:${cleaned}`;
	}), params));
}
async function listDiscordDirectoryGroupsFromConfig(params) {
	const account = resolveDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const ids = /* @__PURE__ */ new Set();
	for (const guild of Object.values(account.config.guilds ?? {})) addTrimmedEntries(ids, Object.keys(guild.channels ?? {}));
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(normalizeTrimmedSet(ids, (raw) => {
		const cleaned = (raw.match(/^<#(\d+)>$/)?.[1] ?? raw).replace(/^(discord|channel|group):/i, "").trim();
		if (!/^\d+$/.test(cleaned)) return null;
		return `channel:${cleaned}`;
	}), params));
}
async function listTelegramDirectoryPeersFromConfig(params) {
	const account = resolveTelegramAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const raw = [...(account.config.allowFrom ?? []).map((entry) => String(entry)), ...Object.keys(account.config.dms ?? {})];
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(Array.from(new Set(raw.map((entry) => entry.trim()).filter(Boolean).map((entry) => entry.replace(/^(telegram|tg):/i, "")))).map((entry) => {
		const trimmed = entry.trim();
		if (!trimmed) return null;
		if (/^-?\d+$/.test(trimmed)) return trimmed;
		return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
	}).filter((id) => Boolean(id)), params));
}
async function listTelegramDirectoryGroupsFromConfig(params) {
	const account = resolveTelegramAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(Object.keys(account.config.groups ?? {}).map((id) => id.trim()).filter((id) => Boolean(id) && id !== "*"), params));
}
async function listWhatsAppDirectoryPeersFromConfig(params) {
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit((resolveWhatsAppAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).allowFrom ?? []).map((entry) => String(entry).trim()).filter((entry) => Boolean(entry) && entry !== "*").map((entry) => normalizeWhatsAppTarget(entry) ?? "").filter(Boolean).filter((id) => !isWhatsAppGroupJid(id)), params));
}
async function listWhatsAppDirectoryGroupsFromConfig(params) {
	const account = resolveWhatsAppAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(Object.keys(account.groups ?? {}).map((id) => id.trim()).filter((id) => Boolean(id) && id !== "*"), params));
}

//#endregion
//#region src/channels/plugins/index.ts
function dedupeChannels(channels) {
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	for (const plugin of channels) {
		const id = String(plugin.id).trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		resolved.push(plugin);
	}
	return resolved;
}
let cachedChannelPlugins = {
	registryVersion: -1,
	sorted: [],
	byId: /* @__PURE__ */ new Map()
};
function resolveCachedChannelPlugins() {
	const registry = requireActivePluginRegistry();
	const registryVersion = getActivePluginRegistryVersion();
	const cached = cachedChannelPlugins;
	if (cached.registryVersion === registryVersion) return cached;
	const sorted = dedupeChannels(registry.channels.map((entry) => entry.plugin)).toSorted((a, b) => {
		const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id);
		const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id);
		const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
		const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
		if (orderA !== orderB) return orderA - orderB;
		return a.id.localeCompare(b.id);
	});
	const byId = /* @__PURE__ */ new Map();
	for (const plugin of sorted) byId.set(plugin.id, plugin);
	const next = {
		registryVersion,
		sorted,
		byId
	};
	cachedChannelPlugins = next;
	return next;
}
function listChannelPlugins() {
	return resolveCachedChannelPlugins().sorted.slice();
}
function getChannelPlugin(id) {
	const resolvedId = String(id).trim();
	if (!resolvedId) return;
	return resolveCachedChannelPlugins().byId.get(resolvedId);
}
function normalizeChannelId(raw) {
	return normalizeAnyChannelId(raw);
}

//#endregion
export { listEnabledSlackAccounts as A, listDiscordAccountIds as B, resolveTelegramAccount as C, listAcpBindings as D, listBindings as E, resolveSlackAppToken as F, normalizeChatType as G, resolveDefaultDiscordAccountId as H, resolveSlackBotToken as I, isWhatsAppGroupJid as L, resolveDefaultSlackAccountId as M, resolveSlackAccount as N, listConfiguredAccountIds$1 as O, resolveSlackReplyToMode as P, normalizeWhatsAppTarget as R, resolveDefaultTelegramAccountId as S, buildChannelAccountBindings as T, resolveDiscordAccount as U, listEnabledDiscordAccounts as V, normalizeDiscordToken as W, parseMentionPrefixOrAtUserTarget as _, listDiscordDirectoryPeersFromConfig as a, listEnabledTelegramAccounts as b, listTelegramDirectoryGroupsFromConfig as c, listWhatsAppDirectoryPeersFromConfig as d, looksLikeSlackTargetId as f, buildMessagingTarget as g, resolveSlackChannelId as h, listDiscordDirectoryGroupsFromConfig as i, listSlackAccountIds as j, resolveAccountWithDefaultFallback as k, listTelegramDirectoryPeersFromConfig as l, parseSlackTarget as m, listChannelPlugins as n, listSlackDirectoryGroupsFromConfig as o, normalizeSlackMessagingTarget as p, normalizeChannelId as r, listSlackDirectoryPeersFromConfig as s, getChannelPlugin as t, listWhatsAppDirectoryGroupsFromConfig as u, requireTargetKind as v, resolveTelegramToken as w, listTelegramAccountIds as x, createTelegramActionGate as y, createDiscordActionGate as z };