import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { n as normalizeAccountId, r as normalizeOptionalAccountId } from "./account-id-B32J-iNN.js";
import { n as resolveNormalizedAccountEntry } from "./account-lookup-CQEoGO1F.js";
import { a as listCombinedAccountIds } from "./account-helpers-BEXOONiv.js";
import { c as getChatChannelMeta } from "./core-kXuNbs5U.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import "./setup-DPvocg6M.js";
import "./account-resolution-Dy8RKAMt.js";
import { n as isAccountConfigured, o as resolveTwitchToken } from "./twitch-Fn_6OQpS.js";
//#region extensions/twitch/src/config.ts
/**
* Default account ID for Twitch
*/
const DEFAULT_ACCOUNT_ID = "default";
/**
* Get account config from core config
*
* Handles two patterns:
* 1. Simplified single-account: base-level properties create implicit "default" account
* 2. Multi-account: explicit accounts object
*
* For "default" account, base-level properties take precedence over accounts.default
* For other accounts, only the accounts object is checked
*/
function getAccountConfig(coreConfig, accountId) {
	if (!coreConfig || typeof coreConfig !== "object") return null;
	const cfg = coreConfig;
	const normalizedAccountId = normalizeAccountId(accountId);
	const twitchRaw = cfg.channels?.twitch;
	const accounts = twitchRaw?.accounts;
	if (normalizedAccountId === "default") {
		const accountFromAccounts = resolveNormalizedAccountEntry(accounts, DEFAULT_ACCOUNT_ID, normalizeAccountId);
		const baseLevel = {
			username: typeof twitchRaw?.username === "string" ? twitchRaw.username : void 0,
			accessToken: typeof twitchRaw?.accessToken === "string" ? twitchRaw.accessToken : void 0,
			clientId: typeof twitchRaw?.clientId === "string" ? twitchRaw.clientId : void 0,
			channel: typeof twitchRaw?.channel === "string" ? twitchRaw.channel : void 0,
			enabled: typeof twitchRaw?.enabled === "boolean" ? twitchRaw.enabled : void 0,
			allowFrom: Array.isArray(twitchRaw?.allowFrom) ? twitchRaw.allowFrom : void 0,
			allowedRoles: Array.isArray(twitchRaw?.allowedRoles) ? twitchRaw.allowedRoles : void 0,
			requireMention: typeof twitchRaw?.requireMention === "boolean" ? twitchRaw.requireMention : void 0,
			clientSecret: typeof twitchRaw?.clientSecret === "string" ? twitchRaw.clientSecret : void 0,
			refreshToken: typeof twitchRaw?.refreshToken === "string" ? twitchRaw.refreshToken : void 0,
			expiresIn: typeof twitchRaw?.expiresIn === "number" ? twitchRaw.expiresIn : void 0,
			obtainmentTimestamp: typeof twitchRaw?.obtainmentTimestamp === "number" ? twitchRaw.obtainmentTimestamp : void 0
		};
		const merged = {
			...accountFromAccounts,
			...baseLevel
		};
		if (merged.username) return merged;
		if (accountFromAccounts) return accountFromAccounts;
		return null;
	}
	const account = resolveNormalizedAccountEntry(accounts, normalizedAccountId, normalizeAccountId);
	if (!account) return null;
	return account;
}
/**
* List all configured account IDs
*
* Includes both explicit accounts and implicit "default" from base-level config
*/
function listAccountIds(cfg) {
	const twitchRaw = cfg.channels?.twitch;
	const accountMap = twitchRaw?.accounts;
	const hasBaseLevelConfig = twitchRaw && (typeof twitchRaw.username === "string" || typeof twitchRaw.accessToken === "string" || typeof twitchRaw.channel === "string");
	return listCombinedAccountIds({
		configuredAccountIds: Object.keys(accountMap ?? {}).map((accountId) => normalizeAccountId(accountId)),
		implicitAccountId: hasBaseLevelConfig ? DEFAULT_ACCOUNT_ID : void 0
	});
}
function resolveDefaultTwitchAccountId(cfg) {
	const preferredRaw = typeof cfg.channels?.twitch?.defaultAccount === "string" ? cfg.channels.twitch.defaultAccount.trim() : "";
	const preferred = preferredRaw ? normalizeAccountId(preferredRaw) : "";
	const ids = listAccountIds(cfg);
	if (preferred && ids.includes(preferred)) return preferred;
	if (ids.includes("default")) return DEFAULT_ACCOUNT_ID;
	return ids[0] ?? "default";
}
function resolveTwitchAccountContext(cfg, accountId) {
	const resolvedAccountId = accountId?.trim() ? normalizeAccountId(accountId) : resolveDefaultTwitchAccountId(cfg);
	const account = getAccountConfig(cfg, resolvedAccountId);
	const tokenResolution = resolveTwitchToken(cfg, { accountId: resolvedAccountId });
	return {
		accountId: resolvedAccountId,
		account,
		tokenResolution,
		configured: account ? isAccountConfigured(account, tokenResolution.token) : false,
		availableAccountIds: listAccountIds(cfg)
	};
}
function resolveTwitchSnapshotAccountId(cfg, account) {
	const accountMap = (cfg.channels?.twitch)?.accounts ?? {};
	return Object.entries(accountMap).find(([, value]) => value === account)?.[0] ?? "default";
}
//#endregion
//#region extensions/twitch/src/setup-surface.ts
/**
* Twitch setup wizard surface for CLI setup.
*/
const channel = "twitch";
const t = createSetupTranslator();
const INVALID_ACCOUNT_ID_MESSAGE = "Invalid Twitch account id";
function normalizeRequestedSetupAccountId(accountId) {
	const normalized = normalizeOptionalAccountId(accountId);
	if (!normalized) throw new Error(INVALID_ACCOUNT_ID_MESSAGE);
	return normalized;
}
function resolveSetupAccountId(cfg, requestedAccountId) {
	const requested = requestedAccountId?.trim();
	if (requested) return normalizeRequestedSetupAccountId(requested);
	const preferred = cfg.channels?.twitch?.defaultAccount?.trim();
	return preferred ? normalizeAccountId(preferred) : resolveDefaultTwitchAccountId(cfg);
}
function setTwitchAccount(cfg, account, accountId = resolveSetupAccountId(cfg)) {
	const resolvedAccountId = accountId.trim() ? normalizeRequestedSetupAccountId(accountId) : resolveSetupAccountId(cfg);
	const existing = getAccountConfig(cfg, resolvedAccountId);
	const merged = {
		username: account.username ?? existing?.username ?? "",
		accessToken: account.accessToken ?? existing?.accessToken ?? "",
		clientId: account.clientId ?? existing?.clientId ?? "",
		channel: account.channel ?? existing?.channel ?? "",
		enabled: account.enabled ?? existing?.enabled ?? true,
		allowFrom: account.allowFrom ?? existing?.allowFrom,
		allowedRoles: account.allowedRoles ?? existing?.allowedRoles,
		requireMention: account.requireMention ?? existing?.requireMention,
		clientSecret: account.clientSecret ?? existing?.clientSecret,
		refreshToken: account.refreshToken ?? existing?.refreshToken,
		expiresIn: account.expiresIn ?? existing?.expiresIn,
		obtainmentTimestamp: account.obtainmentTimestamp ?? existing?.obtainmentTimestamp
	};
	return {
		...cfg,
		channels: {
			...cfg.channels,
			twitch: {
				...cfg.channels?.twitch,
				enabled: true,
				accounts: {
					...(cfg.channels?.twitch)?.accounts,
					[resolvedAccountId]: merged
				}
			}
		}
	};
}
async function noteTwitchSetupHelp(prompter) {
	await prompter.note([
		t("wizard.twitch.helpRequiresBot"),
		t("wizard.twitch.helpCreateApp"),
		t("wizard.twitch.helpGenerateToken"),
		t("wizard.twitch.helpTokenTools"),
		t("wizard.twitch.helpCopyToken"),
		t("wizard.twitch.helpEnvVars"),
		`Docs: ${formatDocsLink("/channels/twitch", "channels/twitch")}`
	].join("\n"), t("wizard.twitch.setupTitle"));
}
async function promptToken(prompter, account, envToken) {
	const existingToken = account?.accessToken ?? "";
	if (existingToken && !envToken) {
		if (await prompter.confirm({
			message: t("wizard.twitch.accessTokenKeep"),
			initialValue: true
		})) return existingToken;
	}
	return (await prompter.text({
		message: t("wizard.twitch.oauthTokenPrompt"),
		initialValue: envToken ?? "",
		validate: (value) => {
			const raw = value?.trim() ?? "";
			if (!raw) return "Required";
			if (!raw.startsWith("oauth:")) return "Token should start with 'oauth:'";
		}
	})).trim();
}
async function promptUsername(prompter, account) {
	return (await prompter.text({
		message: t("wizard.twitch.botUsernamePrompt"),
		initialValue: account?.username ?? "",
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
}
async function promptClientId(prompter, account) {
	return (await prompter.text({
		message: t("wizard.twitch.clientIdPrompt"),
		initialValue: account?.clientId ?? "",
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
}
async function promptChannelName(prompter, account) {
	return (await prompter.text({
		message: t("wizard.twitch.channelJoinPrompt"),
		initialValue: account?.channel ?? "",
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
}
async function promptRefreshTokenSetup(prompter, account) {
	if (!await prompter.confirm({
		message: t("wizard.twitch.refreshTokenPrompt"),
		initialValue: Boolean(account?.clientSecret && account?.refreshToken)
	})) return {};
	return {
		clientSecret: (await prompter.text({
			message: t("wizard.twitch.clientSecretPrompt"),
			initialValue: account?.clientSecret ?? "",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim() || void 0,
		refreshToken: (await prompter.text({
			message: t("wizard.twitch.refreshTokenInputPrompt"),
			initialValue: account?.refreshToken ?? "",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim() || void 0
	};
}
async function configureWithEnvToken(cfg, prompter, account, envToken, forceAllowFrom, dmPolicy, accountId = resolveSetupAccountId(cfg)) {
	const resolvedAccountId = accountId.trim() ? normalizeRequestedSetupAccountId(accountId) : resolveSetupAccountId(cfg);
	if (resolvedAccountId !== "default") return null;
	if (!await prompter.confirm({
		message: t("wizard.twitch.envPrompt"),
		initialValue: true
	})) return null;
	const cfgWithAccount = setTwitchAccount(cfg, {
		username: await promptUsername(prompter, account),
		clientId: await promptClientId(prompter, account),
		accessToken: envToken,
		enabled: true
	}, resolvedAccountId);
	if (forceAllowFrom && dmPolicy.promptAllowFrom) return { cfg: await dmPolicy.promptAllowFrom({
		cfg: cfgWithAccount,
		prompter,
		accountId: resolvedAccountId
	}) };
	return { cfg: cfgWithAccount };
}
function setTwitchAccessControl(cfg, allowedRoles, requireMention, accountId) {
	const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
	const account = getAccountConfig(cfg, resolvedAccountId);
	if (!account) return cfg;
	return setTwitchAccount(cfg, {
		...account,
		allowedRoles,
		requireMention
	}, resolvedAccountId);
}
function resolveTwitchGroupPolicy(cfg, accountId) {
	const account = getAccountConfig(cfg, resolveSetupAccountId(cfg, accountId));
	if (account?.allowedRoles?.includes("all")) return "open";
	if (account?.allowedRoles?.includes("moderator")) return "allowlist";
	return "disabled";
}
function setTwitchGroupPolicy(cfg, policy, accountId) {
	return setTwitchAccessControl(cfg, policy === "open" ? ["all"] : policy === "allowlist" ? ["moderator", "vip"] : [], true, accountId);
}
const twitchDmPolicy = {
	label: "Twitch",
	channel,
	policyKey: "channels.twitch.accounts.default.allowedRoles",
	allowFromKey: "channels.twitch.accounts.default.allowFrom",
	resolveConfigKeys: (cfg, accountId) => {
		const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
		return {
			policyKey: `channels.twitch.accounts.${resolvedAccountId}.allowedRoles`,
			allowFromKey: `channels.twitch.accounts.${resolvedAccountId}.allowFrom`
		};
	},
	getCurrent: (cfg, accountId) => {
		const account = getAccountConfig(cfg, resolveSetupAccountId(cfg, accountId));
		if (account?.allowedRoles?.includes("all")) return "open";
		if (account?.allowFrom && account.allowFrom.length > 0) return "allowlist";
		return "disabled";
	},
	setPolicy: (cfg, policy, accountId) => {
		return setTwitchAccessControl(cfg, policy === "open" ? ["all"] : policy === "allowlist" ? [] : ["moderator"], true, accountId);
	},
	promptAllowFrom: async ({ cfg, prompter, accountId }) => {
		const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
		const account = getAccountConfig(cfg, resolvedAccountId);
		const existingAllowFrom = account?.allowFrom ?? [];
		const allowFrom = (await prompter.text({
			message: t("wizard.twitch.allowFromPrompt"),
			placeholder: "123456789",
			initialValue: existingAllowFrom[0] || void 0
		}) ?? "").split(/[\n,;]+/g).map((s) => s.trim()).filter(Boolean);
		return setTwitchAccount(cfg, {
			...account ?? void 0,
			allowFrom
		}, resolvedAccountId);
	}
};
const twitchGroupAccess = {
	label: "Twitch chat",
	placeholder: "",
	skipAllowlistEntries: true,
	currentPolicy: ({ cfg, accountId }) => resolveTwitchGroupPolicy(cfg, accountId),
	currentEntries: ({ cfg, accountId }) => {
		return getAccountConfig(cfg, resolveSetupAccountId(cfg, accountId))?.allowFrom ?? [];
	},
	updatePrompt: ({ cfg, accountId }) => {
		const account = getAccountConfig(cfg, resolveSetupAccountId(cfg, accountId));
		return Boolean(account?.allowedRoles?.length || account?.allowFrom?.length);
	},
	setPolicy: ({ cfg, accountId, policy }) => setTwitchGroupPolicy(cfg, policy, accountId),
	resolveAllowlist: async () => [],
	applyAllowlist: ({ cfg }) => cfg
};
const twitchSetupAdapter = {
	resolveAccountId: ({ cfg }) => resolveSetupAccountId(cfg),
	applyAccountConfig: ({ cfg, accountId }) => setTwitchAccount(cfg, { enabled: true }, accountId)
};
const twitchSetupWizard = {
	channel,
	resolveAccountIdForConfigure: ({ cfg, accountOverride }) => resolveSetupAccountId(cfg, accountOverride),
	resolveShouldPromptAccountIds: () => false,
	status: {
		configuredLabel: t("wizard.channels.statusConfigured"),
		unconfiguredLabel: t("wizard.channels.statusNeedsUsernameTokenClientId"),
		configuredHint: t("wizard.channels.statusConfigured"),
		unconfiguredHint: t("wizard.channels.statusNeedsSetup"),
		resolveConfigured: ({ cfg, accountId }) => {
			return resolveTwitchAccountContext(cfg, resolveSetupAccountId(cfg, accountId)).configured;
		},
		resolveStatusLines: ({ cfg, accountId }) => {
			const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
			const configured = resolveTwitchAccountContext(cfg, resolvedAccountId).configured;
			return [`Twitch${resolvedAccountId !== "default" ? ` (${resolvedAccountId})` : ""}: ${configured ? t("wizard.channels.statusConfigured") : t("wizard.channels.statusNeedsUsernameTokenClientId")}`];
		}
	},
	credentials: [],
	finalize: async ({ cfg, accountId: requestedAccountId, prompter, forceAllowFrom }) => {
		const accountId = resolveSetupAccountId(cfg, requestedAccountId);
		const account = getAccountConfig(cfg, accountId);
		if (!account || !isAccountConfigured(account)) await noteTwitchSetupHelp(prompter);
		const envToken = process.env.OPENCLAW_TWITCH_ACCESS_TOKEN?.trim();
		if (accountId === "default" && envToken && !account?.accessToken) {
			const envResult = await configureWithEnvToken(cfg, prompter, account, envToken, forceAllowFrom, twitchDmPolicy, accountId);
			if (envResult) return envResult;
		}
		const username = await promptUsername(prompter, account);
		const token = await promptToken(prompter, account, envToken);
		const clientId = await promptClientId(prompter, account);
		const channelName = await promptChannelName(prompter, account);
		const { clientSecret, refreshToken } = await promptRefreshTokenSetup(prompter, account);
		const cfgWithAccount = setTwitchAccount(cfg, {
			username,
			accessToken: token,
			clientId,
			channel: channelName,
			clientSecret,
			refreshToken,
			enabled: true
		}, accountId);
		return { cfg: forceAllowFrom && twitchDmPolicy.promptAllowFrom ? await twitchDmPolicy.promptAllowFrom({
			cfg: cfgWithAccount,
			prompter,
			accountId
		}) : cfgWithAccount };
	},
	dmPolicy: twitchDmPolicy,
	groupAccess: twitchGroupAccess,
	disable: (cfg) => {
		const twitch = cfg.channels?.twitch;
		return {
			...cfg,
			channels: {
				...cfg.channels,
				twitch: {
					...twitch,
					enabled: false
				}
			}
		};
	}
};
const twitchSetupPlugin = {
	id: channel,
	meta: getChatChannelMeta(channel),
	capabilities: { chatTypes: ["group"] },
	config: {
		listAccountIds: (cfg) => listAccountIds(cfg),
		resolveAccount: (cfg, accountId) => {
			const resolvedAccountId = normalizeAccountId(accountId ?? resolveDefaultTwitchAccountId(cfg));
			const account = getAccountConfig(cfg, resolvedAccountId);
			if (!account) return {
				accountId: resolvedAccountId,
				username: "",
				accessToken: "",
				clientId: "",
				channel: "",
				enabled: false
			};
			return {
				accountId: resolvedAccountId,
				...account
			};
		},
		defaultAccountId: (cfg) => resolveDefaultTwitchAccountId(cfg),
		isConfigured: (account, cfg) => resolveTwitchAccountContext(cfg, account?.accountId).configured,
		isEnabled: (account) => account.enabled !== false
	},
	setup: twitchSetupAdapter,
	setupWizard: twitchSetupWizard
};
//#endregion
export { getAccountConfig as a, resolveTwitchAccountContext as c, DEFAULT_ACCOUNT_ID as i, resolveTwitchSnapshotAccountId as l, twitchSetupPlugin as n, listAccountIds as o, twitchSetupWizard as r, resolveDefaultTwitchAccountId as s, twitchSetupAdapter as t };
