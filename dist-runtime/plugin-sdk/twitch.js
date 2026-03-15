import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-CbP51u9x.js";
import "./runtime-DRRlb-lt.js";
import "./logger-DEV1v8zB.js";
import "./tmp-openclaw-dir-DGafsubg.js";
import "./subsystem-BunQspj4.js";
import "./utils-C9epF7GR.js";
import "./fetch-s6LpGbVn.js";
import "./retry-Bdb5CNwD.js";
import { t as emptyPluginConfigSchema } from "./config-schema-X8cahxVt.js";
import { T as MarkdownConfigSchema, u as buildChannelConfigSchema } from "./config-helpers-C9J9Kf27.js";
import "./exec-LHBFP7K9.js";
import "./agent-scope-BAdJcjtf.js";
import { n as createReplyPrefixOptions, u as formatDocsLink } from "./reply-prefix-B-13vT7e.js";
import "./logger-kC9I1OJ3.js";
import "node:crypto";
//#region extensions/twitch/src/config.ts
/**
* Default account ID for Twitch
*/
const DEFAULT_ACCOUNT_ID$1 = "default";
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
	if (!coreConfig || typeof coreConfig !== "object") {return null;}
	const twitchRaw = coreConfig.channels?.twitch;
	const accounts = twitchRaw?.accounts;
	if (accountId === "default") {
		const accountFromAccounts = accounts?.[DEFAULT_ACCOUNT_ID$1];
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
		if (merged.username) {return merged;}
		if (accountFromAccounts) {return accountFromAccounts;}
		return null;
	}
	if (!accounts || !accounts[accountId]) {return null;}
	return accounts[accountId];
}
//#endregion
//#region extensions/twitch/src/utils/twitch.ts
/**
* Check if an account is properly configured with required credentials.
*
* @param account - The Twitch account config to check
* @returns true if the account has required credentials
*/
function isAccountConfigured(account, resolvedToken) {
	const token = resolvedToken ?? account?.accessToken;
	return Boolean(account?.username && token && account?.clientId);
}
//#endregion
//#region extensions/twitch/src/setup-surface.ts
const channel = "twitch";
function setTwitchAccount(cfg, account) {
	const existing = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID$1);
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
					[DEFAULT_ACCOUNT_ID$1]: merged
				}
			}
		}
	};
}
async function noteTwitchSetupHelp(prompter) {
	await prompter.note([
		"Twitch requires a bot account with OAuth token.",
		"1. Create a Twitch application at https://dev.twitch.tv/console",
		"2. Generate a token with scopes: chat:read and chat:write",
		"   Use https://twitchtokengenerator.com/ or https://twitchapps.com/tmi/",
		"3. Copy the token (starts with 'oauth:') and Client ID",
		"Env vars supported: OPENCLAW_TWITCH_ACCESS_TOKEN",
		`Docs: ${formatDocsLink("/channels/twitch", "channels/twitch")}`
	].join("\n"), "Twitch setup");
}
async function promptToken(prompter, account, envToken) {
	const existingToken = account?.accessToken ?? "";
	if (existingToken && !envToken) {
		if (await prompter.confirm({
			message: "Access token already configured. Keep it?",
			initialValue: true
		})) {return existingToken;}
	}
	return String(await prompter.text({
		message: "Twitch OAuth token (oauth:...)",
		initialValue: envToken ?? "",
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) {return "Required";}
			if (!raw.startsWith("oauth:")) {return "Token should start with 'oauth:'";}
		}
	})).trim();
}
async function promptUsername(prompter, account) {
	return String(await prompter.text({
		message: "Twitch bot username",
		initialValue: account?.username ?? "",
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
}
async function promptClientId(prompter, account) {
	return String(await prompter.text({
		message: "Twitch Client ID",
		initialValue: account?.clientId ?? "",
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
}
async function promptChannelName(prompter, account) {
	return String(await prompter.text({
		message: "Channel to join",
		initialValue: account?.channel ?? "",
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
}
async function promptRefreshTokenSetup(prompter, account) {
	if (!await prompter.confirm({
		message: "Enable automatic token refresh (requires client secret and refresh token)?",
		initialValue: Boolean(account?.clientSecret && account?.refreshToken)
	})) {return {};}
	return {
		clientSecret: String(await prompter.text({
			message: "Twitch Client Secret (for token refresh)",
			initialValue: account?.clientSecret ?? "",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim() || void 0,
		refreshToken: String(await prompter.text({
			message: "Twitch Refresh Token",
			initialValue: account?.refreshToken ?? "",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim() || void 0
	};
}
async function configureWithEnvToken(cfg, prompter, account, envToken, forceAllowFrom, dmPolicy) {
	if (!await prompter.confirm({
		message: "Twitch env var OPENCLAW_TWITCH_ACCESS_TOKEN detected. Use env token?",
		initialValue: true
	})) {return null;}
	const cfgWithAccount = setTwitchAccount(cfg, {
		username: await promptUsername(prompter, account),
		clientId: await promptClientId(prompter, account),
		accessToken: "",
		enabled: true
	});
	if (forceAllowFrom && dmPolicy.promptAllowFrom) {return { cfg: await dmPolicy.promptAllowFrom({
		cfg: cfgWithAccount,
		prompter
	}) };}
	return { cfg: cfgWithAccount };
}
function setTwitchAccessControl(cfg, allowedRoles, requireMention) {
	const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID$1);
	if (!account) {return cfg;}
	return setTwitchAccount(cfg, {
		...account,
		allowedRoles,
		requireMention
	});
}
function resolveTwitchGroupPolicy(cfg) {
	const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID$1);
	if (account?.allowedRoles?.includes("all")) {return "open";}
	if (account?.allowedRoles?.includes("moderator")) {return "allowlist";}
	return "disabled";
}
function setTwitchGroupPolicy(cfg, policy) {
	return setTwitchAccessControl(cfg, policy === "open" ? ["all"] : policy === "allowlist" ? ["moderator", "vip"] : [], true);
}
const twitchDmPolicy = {
	label: "Twitch",
	channel,
	policyKey: "channels.twitch.allowedRoles",
	allowFromKey: "channels.twitch.accounts.default.allowFrom",
	getCurrent: (cfg) => {
		const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID$1);
		if (account?.allowedRoles?.includes("all")) {return "open";}
		if (account?.allowFrom && account.allowFrom.length > 0) {return "allowlist";}
		return "disabled";
	},
	setPolicy: (cfg, policy) => {
		return setTwitchAccessControl(cfg, policy === "open" ? ["all"] : policy === "allowlist" ? [] : ["moderator"], true);
	},
	promptAllowFrom: async ({ cfg, prompter }) => {
		const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID$1);
		const existingAllowFrom = account?.allowFrom ?? [];
		const entry = await prompter.text({
			message: "Twitch allowFrom (user IDs, one per line, recommended for security)",
			placeholder: "123456789",
			initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : void 0
		});
		const allowFrom = String(entry ?? "").split(/[\n,;]+/g).map((s) => s.trim()).filter(Boolean);
		return setTwitchAccount(cfg, {
			...account ?? void 0,
			allowFrom
		});
	}
};
const twitchGroupAccess = {
	label: "Twitch chat",
	placeholder: "",
	skipAllowlistEntries: true,
	currentPolicy: ({ cfg }) => resolveTwitchGroupPolicy(cfg),
	currentEntries: ({ cfg }) => {
		return getAccountConfig(cfg, "default")?.allowFrom ?? [];
	},
	updatePrompt: ({ cfg }) => {
		const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID$1);
		return Boolean(account?.allowedRoles?.length || account?.allowFrom?.length);
	},
	setPolicy: ({ cfg, policy }) => setTwitchGroupPolicy(cfg, policy),
	resolveAllowlist: async () => [],
	applyAllowlist: ({ cfg }) => cfg
};
const twitchSetupAdapter = {
	resolveAccountId: () => DEFAULT_ACCOUNT_ID$1,
	applyAccountConfig: ({ cfg }) => setTwitchAccount(cfg, { enabled: true })
};
const twitchSetupWizard = {
	channel,
	resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID$1,
	resolveShouldPromptAccountIds: () => false,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs username, token, and clientId",
		configuredHint: "configured",
		unconfiguredHint: "needs setup",
		resolveConfigured: ({ cfg }) => {
			const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID$1);
			return account ? isAccountConfigured(account) : false;
		},
		resolveStatusLines: ({ cfg }) => {
			const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID$1);
			return [`Twitch: ${(account ? isAccountConfigured(account) : false) ? "configured" : "needs username, token, and clientId"}`];
		}
	},
	credentials: [],
	finalize: async ({ cfg, prompter, forceAllowFrom }) => {
		const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID$1);
		if (!account || !isAccountConfigured(account)) {await noteTwitchSetupHelp(prompter);}
		const envToken = process.env.OPENCLAW_TWITCH_ACCESS_TOKEN?.trim();
		if (envToken && !account?.accessToken) {
			const envResult = await configureWithEnvToken(cfg, prompter, account, envToken, forceAllowFrom, twitchDmPolicy);
			if (envResult) {return envResult;}
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
		});
		return { cfg: forceAllowFrom && twitchDmPolicy.promptAllowFrom ? await twitchDmPolicy.promptAllowFrom({
			cfg: cfgWithAccount,
			prompter
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
//#endregion
export { DEFAULT_ACCOUNT_ID, MarkdownConfigSchema, buildChannelConfigSchema, createReplyPrefixOptions, emptyPluginConfigSchema, formatDocsLink, normalizeAccountId, twitchSetupAdapter, twitchSetupWizard };
