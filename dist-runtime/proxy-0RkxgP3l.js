import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-BfFG0xOA.js";
import { $t as createAccountListHelpers, d as tryReadSecretFileSync, dr as applyAccountNameToChannelSection, fr as applySetupAccountConfigPatch, pr as migrateBaseNameToDefaultAccount } from "./resolve-route-BZ4hHpx2.js";
import { c as normalizeSecretInputString, i as hasConfiguredSecretInput, s as normalizeResolvedSecretInputString } from "./types.secrets-apkw3WZr.js";
import { Cl as formatDocsLink, El as mergeAllowFromEntries, Ml as promptSingleChannelSecretInput, Pl as runSingleChannelSecretStep, Rl as setTopLevelChannelDmPolicyWithAllowFrom, Tl as buildSingleChannelSecretPromptState } from "./auth-profiles-CuJtivJK.js";
import { ProxyAgent, fetch as fetch$1 } from "undici";
//#region extensions/zalo/src/setup-core.ts
const channel$1 = "zalo";
const zaloSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel$1,
		accountId,
		name
	}),
	validateInput: ({ accountId, input }) => {
		if (input.useEnv && accountId !== "default") {return "ZALO_BOT_TOKEN can only be used for the default account.";}
		if (!input.useEnv && !input.token && !input.tokenFile) {return "Zalo requires token or --token-file (or --use-env).";}
		return null;
	},
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const namedConfig = applyAccountNameToChannelSection({
			cfg,
			channelKey: channel$1,
			accountId,
			name: input.name
		});
		return applySetupAccountConfigPatch({
			cfg: accountId !== "default" ? migrateBaseNameToDefaultAccount({
				cfg: namedConfig,
				channelKey: channel$1
			}) : namedConfig,
			channelKey: channel$1,
			accountId,
			patch: input.useEnv ? {} : input.tokenFile ? { tokenFile: input.tokenFile } : input.token ? { botToken: input.token } : {}
		});
	}
};
//#endregion
//#region extensions/zalo/src/token.ts
function readTokenFromFile(tokenFile) {
	return tryReadSecretFileSync(tokenFile, "Zalo token file", { rejectSymlink: true }) ?? "";
}
function resolveZaloToken(config, accountId, options) {
	const resolvedAccountId = accountId ?? "default";
	const isDefaultAccount = resolvedAccountId === DEFAULT_ACCOUNT_ID;
	const baseConfig = config;
	const resolveAccountConfig = (id) => {
		const accounts = baseConfig?.accounts;
		if (!accounts || typeof accounts !== "object") {return;}
		const direct = accounts[id];
		if (direct) {return direct;}
		const normalized = normalizeAccountId(id);
		const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
		return matchKey ? accounts[matchKey] ?? void 0 : void 0;
	};
	const accountConfig = resolveAccountConfig(resolvedAccountId);
	const accountHasBotToken = Boolean(accountConfig && Object.prototype.hasOwnProperty.call(accountConfig, "botToken"));
	if (accountConfig && accountHasBotToken) {
		const token = options?.allowUnresolvedSecretRef ? normalizeSecretInputString(accountConfig.botToken) : normalizeResolvedSecretInputString({
			value: accountConfig.botToken,
			path: `channels.zalo.accounts.${resolvedAccountId}.botToken`
		});
		if (token) {return {
			token,
			source: "config"
		};}
		const fileToken = readTokenFromFile(accountConfig.tokenFile);
		if (fileToken) {return {
			token: fileToken,
			source: "configFile"
		};}
	}
	if (!accountHasBotToken) {
		const fileToken = readTokenFromFile(accountConfig?.tokenFile);
		if (fileToken) {return {
			token: fileToken,
			source: "configFile"
		};}
	}
	if (!accountHasBotToken) {
		const token = options?.allowUnresolvedSecretRef ? normalizeSecretInputString(baseConfig?.botToken) : normalizeResolvedSecretInputString({
			value: baseConfig?.botToken,
			path: "channels.zalo.botToken"
		});
		if (token) {return {
			token,
			source: "config"
		};}
		const fileToken = readTokenFromFile(baseConfig?.tokenFile);
		if (fileToken) {return {
			token: fileToken,
			source: "configFile"
		};}
	}
	if (isDefaultAccount) {
		const envToken = process.env.ZALO_BOT_TOKEN?.trim();
		if (envToken) {return {
			token: envToken,
			source: "env"
		};}
	}
	return {
		token: "",
		source: "none"
	};
}
//#endregion
//#region extensions/zalo/src/accounts.ts
const { listAccountIds: listZaloAccountIds, resolveDefaultAccountId: resolveDefaultZaloAccountId } = createAccountListHelpers("zalo");
function resolveAccountConfig(cfg, accountId) {
	const accounts = (cfg.channels?.zalo)?.accounts;
	if (!accounts || typeof accounts !== "object") {return;}
	return accounts[accountId];
}
function mergeZaloAccountConfig(cfg, accountId) {
	const { accounts: _ignored, defaultAccount: _ignored2, ...base } = cfg.channels?.zalo ?? {};
	const account = resolveAccountConfig(cfg, accountId) ?? {};
	return {
		...base,
		...account
	};
}
function resolveZaloAccount(params) {
	const accountId = normalizeAccountId(params.accountId);
	const baseEnabled = (params.cfg.channels?.zalo)?.enabled !== false;
	const merged = mergeZaloAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const tokenResolution = resolveZaloToken(params.cfg.channels?.zalo, accountId, { allowUnresolvedSecretRef: params.allowUnresolvedSecretRef });
	return {
		accountId,
		name: merged.name?.trim() || void 0,
		enabled,
		token: tokenResolution.token,
		tokenSource: tokenResolution.source,
		config: merged
	};
}
function listEnabledZaloAccounts(cfg) {
	return listZaloAccountIds(cfg).map((accountId) => resolveZaloAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}
//#endregion
//#region extensions/zalo/src/setup-surface.ts
const channel = "zalo";
function setZaloDmPolicy(cfg, dmPolicy) {
	return setTopLevelChannelDmPolicyWithAllowFrom({
		cfg,
		channel,
		dmPolicy
	});
}
function setZaloUpdateMode(cfg, accountId, mode, webhookUrl, webhookSecret, webhookPath) {
	const isDefault = accountId === DEFAULT_ACCOUNT_ID;
	if (mode === "polling") {
		if (isDefault) {
			const { webhookUrl: _url, webhookSecret: _secret, webhookPath: _path, ...rest } = cfg.channels?.zalo ?? {};
			return {
				...cfg,
				channels: {
					...cfg.channels,
					zalo: rest
				}
			};
		}
		const accounts = { ...cfg.channels?.zalo?.accounts };
		const { webhookUrl: _url, webhookSecret: _secret, webhookPath: _path, ...rest } = accounts[accountId] ?? {};
		accounts[accountId] = rest;
		return {
			...cfg,
			channels: {
				...cfg.channels,
				zalo: {
					...cfg.channels?.zalo,
					accounts
				}
			}
		};
	}
	if (isDefault) {return {
		...cfg,
		channels: {
			...cfg.channels,
			zalo: {
				...cfg.channels?.zalo,
				webhookUrl,
				webhookSecret,
				webhookPath
			}
		}
	};}
	const accounts = { ...cfg.channels?.zalo?.accounts };
	accounts[accountId] = {
		...accounts[accountId],
		webhookUrl,
		webhookSecret,
		webhookPath
	};
	return {
		...cfg,
		channels: {
			...cfg.channels,
			zalo: {
				...cfg.channels?.zalo,
				accounts
			}
		}
	};
}
async function noteZaloTokenHelp(prompter) {
	await prompter.note([
		"1) Open Zalo Bot Platform: https://bot.zaloplatforms.com",
		"2) Create a bot and get the token",
		"3) Token looks like 12345689:abc-xyz",
		"Tip: you can also set ZALO_BOT_TOKEN in your env.",
		`Docs: ${formatDocsLink("/channels/zalo", "zalo")}`
	].join("\n"), "Zalo bot token");
}
async function promptZaloAllowFrom(params) {
	const { cfg, prompter, accountId } = params;
	const existingAllowFrom = resolveZaloAccount({
		cfg,
		accountId
	}).config.allowFrom ?? [];
	const entry = await prompter.text({
		message: "Zalo allowFrom (user id)",
		placeholder: "123456789",
		initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : void 0,
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) {return "Required";}
			if (!/^\d+$/.test(raw)) {return "Use a numeric Zalo user id";}
		}
	});
	const unique = mergeAllowFromEntries(existingAllowFrom, [String(entry).trim()]);
	if (accountId === "default") {return {
		...cfg,
		channels: {
			...cfg.channels,
			zalo: {
				...cfg.channels?.zalo,
				enabled: true,
				dmPolicy: "allowlist",
				allowFrom: unique
			}
		}
	};}
	return {
		...cfg,
		channels: {
			...cfg.channels,
			zalo: {
				...cfg.channels?.zalo,
				enabled: true,
				accounts: {
					...cfg.channels?.zalo?.accounts,
					[accountId]: {
						...cfg.channels?.zalo?.accounts?.[accountId],
						enabled: cfg.channels?.zalo?.accounts?.[accountId]?.enabled ?? true,
						dmPolicy: "allowlist",
						allowFrom: unique
					}
				}
			}
		}
	};
}
const zaloSetupWizard = {
	channel,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs token",
		configuredHint: "recommended · configured",
		unconfiguredHint: "recommended · newcomer-friendly",
		configuredScore: 1,
		unconfiguredScore: 10,
		resolveConfigured: ({ cfg }) => listZaloAccountIds(cfg).some((accountId) => {
			const account = resolveZaloAccount({
				cfg,
				accountId,
				allowUnresolvedSecretRef: true
			});
			return Boolean(account.token) || hasConfiguredSecretInput(account.config.botToken) || Boolean(account.config.tokenFile?.trim());
		}),
		resolveStatusLines: ({ cfg, configured }) => {
			return [`Zalo: ${configured ? "configured" : "needs token"}`];
		}
	},
	credentials: [],
	finalize: async ({ cfg, accountId, forceAllowFrom, options, prompter }) => {
		let next = cfg;
		const resolvedAccount = resolveZaloAccount({
			cfg: next,
			accountId,
			allowUnresolvedSecretRef: true
		});
		const accountConfigured = Boolean(resolvedAccount.token);
		const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
		const hasConfigToken = Boolean(hasConfiguredSecretInput(resolvedAccount.config.botToken) || resolvedAccount.config.tokenFile);
		next = (await runSingleChannelSecretStep({
			cfg: next,
			prompter,
			providerHint: "zalo",
			credentialLabel: "bot token",
			secretInputMode: options?.secretInputMode,
			accountConfigured,
			hasConfigToken,
			allowEnv,
			envValue: process.env.ZALO_BOT_TOKEN,
			envPrompt: "ZALO_BOT_TOKEN detected. Use env var?",
			keepPrompt: "Zalo token already configured. Keep it?",
			inputPrompt: "Enter Zalo bot token",
			preferredEnvVar: "ZALO_BOT_TOKEN",
			onMissingConfigured: async () => await noteZaloTokenHelp(prompter),
			applyUseEnv: async (currentCfg) => accountId === "default" ? {
				...currentCfg,
				channels: {
					...currentCfg.channels,
					zalo: {
						...currentCfg.channels?.zalo,
						enabled: true
					}
				}
			} : currentCfg,
			applySet: async (currentCfg, value) => accountId === "default" ? {
				...currentCfg,
				channels: {
					...currentCfg.channels,
					zalo: {
						...currentCfg.channels?.zalo,
						enabled: true,
						botToken: value
					}
				}
			} : {
				...currentCfg,
				channels: {
					...currentCfg.channels,
					zalo: {
						...currentCfg.channels?.zalo,
						enabled: true,
						accounts: {
							...currentCfg.channels?.zalo?.accounts,
							[accountId]: {
								...currentCfg.channels?.zalo?.accounts?.[accountId],
								enabled: true,
								botToken: value
							}
						}
					}
				}
			}
		})).cfg;
		if (await prompter.confirm({
			message: "Use webhook mode for Zalo?",
			initialValue: Boolean(resolvedAccount.config.webhookUrl)
		})) {
			const webhookUrl = String(await prompter.text({
				message: "Webhook URL (https://...) ",
				initialValue: resolvedAccount.config.webhookUrl,
				validate: (value) => value?.trim()?.startsWith("https://") ? void 0 : "HTTPS URL required"
			})).trim();
			const defaultPath = (() => {
				try {
					return new URL(webhookUrl).pathname || "/zalo-webhook";
				} catch {
					return "/zalo-webhook";
				}
			})();
			let webhookSecretResult = await promptSingleChannelSecretInput({
				cfg: next,
				prompter,
				providerHint: "zalo-webhook",
				credentialLabel: "webhook secret",
				secretInputMode: options?.secretInputMode,
				...buildSingleChannelSecretPromptState({
					accountConfigured: hasConfiguredSecretInput(resolvedAccount.config.webhookSecret),
					hasConfigToken: hasConfiguredSecretInput(resolvedAccount.config.webhookSecret),
					allowEnv: false
				}),
				envPrompt: "",
				keepPrompt: "Zalo webhook secret already configured. Keep it?",
				inputPrompt: "Webhook secret (8-256 chars)",
				preferredEnvVar: "ZALO_WEBHOOK_SECRET"
			});
			while (webhookSecretResult.action === "set" && typeof webhookSecretResult.value === "string" && (webhookSecretResult.value.length < 8 || webhookSecretResult.value.length > 256)) {
				await prompter.note("Webhook secret must be between 8 and 256 characters.", "Zalo webhook");
				webhookSecretResult = await promptSingleChannelSecretInput({
					cfg: next,
					prompter,
					providerHint: "zalo-webhook",
					credentialLabel: "webhook secret",
					secretInputMode: options?.secretInputMode,
					...buildSingleChannelSecretPromptState({
						accountConfigured: false,
						hasConfigToken: false,
						allowEnv: false
					}),
					envPrompt: "",
					keepPrompt: "Zalo webhook secret already configured. Keep it?",
					inputPrompt: "Webhook secret (8-256 chars)",
					preferredEnvVar: "ZALO_WEBHOOK_SECRET"
				});
			}
			const webhookSecret = webhookSecretResult.action === "set" ? webhookSecretResult.value : resolvedAccount.config.webhookSecret;
			const webhookPath = String(await prompter.text({
				message: "Webhook path (optional)",
				initialValue: resolvedAccount.config.webhookPath ?? defaultPath
			})).trim();
			next = setZaloUpdateMode(next, accountId, "webhook", webhookUrl, webhookSecret, webhookPath || void 0);
		} else {next = setZaloUpdateMode(next, accountId, "polling");}
		if (forceAllowFrom) {next = await promptZaloAllowFrom({
			cfg: next,
			prompter,
			accountId
		});}
		return { cfg: next };
	},
	dmPolicy: {
		label: "Zalo",
		channel,
		policyKey: "channels.zalo.dmPolicy",
		allowFromKey: "channels.zalo.allowFrom",
		getCurrent: (cfg) => cfg.channels?.zalo?.dmPolicy ?? "pairing",
		setPolicy: (cfg, policy) => setZaloDmPolicy(cfg, policy),
		promptAllowFrom: async ({ cfg, prompter, accountId }) => {
			return await promptZaloAllowFrom({
				cfg,
				prompter,
				accountId: accountId && normalizeAccountId(accountId) ? normalizeAccountId(accountId) ?? "default" : resolveDefaultZaloAccountId(cfg)
			});
		}
	}
};
//#endregion
//#region extensions/zalo/src/api.ts
/**
* Zalo Bot API client
* @see https://bot.zaloplatforms.com/docs
*/
const ZALO_API_BASE = "https://bot-api.zaloplatforms.com";
var ZaloApiError = class extends Error {
	constructor(message, errorCode, description) {
		super(message);
		this.errorCode = errorCode;
		this.description = description;
		this.name = "ZaloApiError";
	}
	/** True if this is a long-polling timeout (no updates available) */
	get isPollingTimeout() {
		return this.errorCode === 408;
	}
};
/**
* Call the Zalo Bot API
*/
async function callZaloApi(method, token, body, options) {
	const url = `${ZALO_API_BASE}/bot${token}/${method}`;
	const controller = new AbortController();
	const timeoutId = options?.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : void 0;
	const fetcher = options?.fetch ?? fetch;
	try {
		const data = await (await fetcher(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : void 0,
			signal: controller.signal
		})).json();
		if (!data.ok) {throw new ZaloApiError(data.description ?? `Zalo API error: ${method}`, data.error_code, data.description);}
		return data;
	} finally {
		if (timeoutId) {clearTimeout(timeoutId);}
	}
}
/**
* Validate bot token and get bot info
*/
async function getMe(token, timeoutMs, fetcher) {
	return callZaloApi("getMe", token, void 0, {
		timeoutMs,
		fetch: fetcher
	});
}
/**
* Send a text message
*/
async function sendMessage(token, params, fetcher) {
	return callZaloApi("sendMessage", token, params, { fetch: fetcher });
}
/**
* Send a photo message
*/
async function sendPhoto(token, params, fetcher) {
	return callZaloApi("sendPhoto", token, params, { fetch: fetcher });
}
/**
* Send a temporary chat action such as typing.
*/
async function sendChatAction(token, params, fetcher, timeoutMs) {
	return callZaloApi("sendChatAction", token, params, {
		timeoutMs,
		fetch: fetcher
	});
}
/**
* Get updates using long polling (dev/testing only)
* Note: Zalo returns a single update per call, not an array like Telegram
*/
async function getUpdates(token, params, fetcher) {
	const pollTimeoutSec = params?.timeout ?? 30;
	const timeoutMs = (pollTimeoutSec + 5) * 1e3;
	return callZaloApi("getUpdates", token, { timeout: String(pollTimeoutSec) }, {
		timeoutMs,
		fetch: fetcher
	});
}
/**
* Set webhook URL for receiving updates
*/
async function setWebhook(token, params, fetcher) {
	return callZaloApi("setWebhook", token, params, { fetch: fetcher });
}
/**
* Delete webhook configuration
*/
async function deleteWebhook(token, fetcher, timeoutMs) {
	return callZaloApi("deleteWebhook", token, void 0, {
		timeoutMs,
		fetch: fetcher
	});
}
/**
* Get current webhook info
*/
async function getWebhookInfo(token, fetcher) {
	return callZaloApi("getWebhookInfo", token, void 0, { fetch: fetcher });
}
//#endregion
//#region extensions/zalo/src/proxy.ts
const proxyCache = /* @__PURE__ */ new Map();
function resolveZaloProxyFetch(proxyUrl) {
	const trimmed = proxyUrl?.trim();
	if (!trimmed) {return;}
	const cached = proxyCache.get(trimmed);
	if (cached) {return cached;}
	const agent = new ProxyAgent(trimmed);
	const fetcher = (input, init) => fetch$1(input, {
		...init,
		dispatcher: agent
	});
	proxyCache.set(trimmed, fetcher);
	return fetcher;
}
//#endregion
export { zaloSetupAdapter as _, getUpdates as a, sendMessage as c, zaloSetupWizard as d, listEnabledZaloAccounts as f, resolveZaloToken as g, resolveZaloAccount as h, getMe as i, sendPhoto as l, resolveDefaultZaloAccountId as m, ZaloApiError as n, getWebhookInfo as o, listZaloAccountIds as p, deleteWebhook as r, sendChatAction as s, resolveZaloProxyFetch as t, setWebhook as u };
