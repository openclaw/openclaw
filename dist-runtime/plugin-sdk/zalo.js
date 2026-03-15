import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-CbP51u9x.js";
import { Ct as warnMissingProviderGroupPolicyFallbackOnce, Gt as hasConfiguredSecretInput, Jt as normalizeResolvedSecretInputString, Yt as normalizeSecretInputString, bt as resolveDefaultGroupPolicy, fn as createAccountListHelpers, l as createDedupeCache, mt as evaluateSenderGroupAccess, xt as resolveOpenProviderRuntimeGroupPolicy } from "./runtime-DRRlb-lt.js";
import { $a as buildSecretInputSchema, Ba as createWebhookAnomalyTracker, Fa as WEBHOOK_ANOMALY_COUNTER_DEFAULTS, It as isNormalizedSenderAllowed, Ka as createScopedPairingAccess, La as WEBHOOK_RATE_LIMIT_DEFAULTS, Mu as resolveClientIp, Nt as formatAllowFromLowercase, Wa as issuePairingChallenge, Zt as waitForAbortSignal, _l as jsonResult, bd as applyBasicWebhookRequestGuards, bl as readStringParam, c as promptSingleChannelSecretInput, eo as createTypingCallbacks, m as setTopLevelChannelDmPolicyWithAllowFrom, mi as extractToolSend, n as buildSingleChannelSecretPromptState, r as mergeAllowFromEntries, ro as logTypingFailure, t as addWildcardAllowFrom, u as runSingleChannelSecretStep, wd as readJsonWebhookBodyOrReject, za as createFixedWindowRateLimiter } from "./setup-wizard-helpers-Bds9SZeS.js";
import "./provider-env-vars-CWXfFyDU.js";
import "./logger-DEV1v8zB.js";
import "./tmp-openclaw-dir-DGafsubg.js";
import "./subsystem-BunQspj4.js";
import "./utils-C9epF7GR.js";
import "./fetch-s6LpGbVn.js";
import "./retry-Bdb5CNwD.js";
import { t as emptyPluginConfigSchema } from "./config-schema-X8cahxVt.js";
import "./paths-BoU0P6Xb.js";
import { c as resolveWebhookTargets, d as resolveWebhookPath, i as resolveSingleWebhookTarget, l as withResolvedWebhookRequestPipeline, n as registerWebhookTargetWithPluginRoute, s as resolveWebhookTargetWithAuthOrRejectSync, t as registerWebhookTarget } from "./webhook-targets-DPRi3syU.js";
import { H as buildBaseAccountStatusSnapshot, q as buildTokenChannelStatusSummary } from "./signal-Bycwzc0M.js";
import { T as MarkdownConfigSchema, a as formatPairingApproveHint, n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection, u as buildChannelConfigSchema } from "./config-helpers-C9J9Kf27.js";
import "./fetch-CokEYQHV.js";
import "./exec-LHBFP7K9.js";
import "./agent-scope-BAdJcjtf.js";
import { n as applySetupAccountConfigPatch, r as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "./setup-helpers-kuIKtuQw.js";
import { T as listDirectoryUserEntriesFromAllowFrom, n as createReplyPrefixOptions, u as formatDocsLink } from "./reply-prefix-B-13vT7e.js";
import "./logger-kC9I1OJ3.js";
import "./fetch-guard-COmtEumo.js";
import "./resolve-route-5UJLanKQ.js";
import "./pairing-token-BUkoGEse.js";
import "./query-expansion-DrHj090u.js";
import "./redact-DDISwu8-.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./channel-plugin-common-cMzLzrLW.js";
import { i as tryReadSecretFileSync } from "./secret-file-B_1xic5c.js";
import { a as resolveSenderCommandAuthorizationWithRuntime, n as resolveChannelAccountConfigBasePath, o as buildChannelSendResult, r as resolveDirectDmAuthorizationOutcome, t as chunkTextForOutbound } from "./text-chunking-Km2nBx_6.js";
import { r as resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope-BE7TyEDo.js";
import { a as resolveOutboundMediaUrls, o as sendMediaWithLeadingCaption, r as isNumericTargetId, s as sendPayloadWithChunkedTextAndMedia } from "./reply-payload-Cm6YO5gx.js";
import "./core.js";
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
export { DEFAULT_ACCOUNT_ID, MarkdownConfigSchema, PAIRING_APPROVED_MESSAGE, WEBHOOK_ANOMALY_COUNTER_DEFAULTS, WEBHOOK_RATE_LIMIT_DEFAULTS, addWildcardAllowFrom, applyAccountNameToChannelSection, applyBasicWebhookRequestGuards, applySetupAccountConfigPatch, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, buildChannelSendResult, buildSecretInputSchema, buildSingleChannelSecretPromptState, buildTokenChannelStatusSummary, chunkTextForOutbound, createAccountListHelpers, createDedupeCache, createFixedWindowRateLimiter, createReplyPrefixOptions, createScopedPairingAccess, createTypingCallbacks, createWebhookAnomalyTracker, deleteAccountFromConfigSection, emptyPluginConfigSchema, evaluateSenderGroupAccess, extractToolSend, formatAllowFromLowercase, formatPairingApproveHint, hasConfiguredSecretInput, isNormalizedSenderAllowed, isNumericTargetId, issuePairingChallenge, jsonResult, listDirectoryUserEntriesFromAllowFrom, logTypingFailure, mergeAllowFromEntries, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeResolvedSecretInputString, normalizeSecretInputString, promptSingleChannelSecretInput, readJsonWebhookBodyOrReject, readStringParam, registerWebhookTarget, registerWebhookTargetWithPluginRoute, resolveChannelAccountConfigBasePath, resolveClientIp, resolveDefaultGroupPolicy, resolveDirectDmAuthorizationOutcome, resolveInboundRouteEnvelopeBuilderWithRuntime, resolveOpenProviderRuntimeGroupPolicy, resolveOutboundMediaUrls, resolveSenderCommandAuthorizationWithRuntime, resolveSingleWebhookTarget, resolveWebhookPath, resolveWebhookTargetWithAuthOrRejectSync, resolveWebhookTargets, runSingleChannelSecretStep, sendMediaWithLeadingCaption, sendPayloadWithChunkedTextAndMedia, setAccountEnabledInConfigSection, setTopLevelChannelDmPolicyWithAllowFrom, waitForAbortSignal, warnMissingProviderGroupPolicyFallbackOnce, withResolvedWebhookRequestPipeline, zaloSetupAdapter, zaloSetupWizard };
