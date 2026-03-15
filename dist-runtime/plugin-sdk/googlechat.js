import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-CbP51u9x.js";
import { Ct as warnMissingProviderGroupPolicyFallbackOnce, I as getChatChannelMeta, Kt as isSecretRef, _t as GROUP_POLICY_BLOCKED_LABEL, bt as resolveDefaultGroupPolicy, fn as createAccountListHelpers, ft as evaluateGroupRouteAccessForPolicy, gt as resolveSenderScopedGroupPolicy, yt as resolveAllowlistProviderRuntimeGroupPolicy } from "./runtime-DRRlb-lt.js";
import { Gt as resolveDmGroupAccessWithLists, Ka as createScopedPairingAccess, Sd as createWebhookInFlightLimiter, Wa as issuePairingChallenge, Xt as resolveMentionGatingWithBypass, _l as jsonResult, bl as readStringParam, g as splitSetupEntries, hl as createActionGate, m as setTopLevelChannelDmPolicyWithAllowFrom, mi as extractToolSend, pc as resolveGoogleChatGroupRequireMention, r as mergeAllowFromEntries, t as addWildcardAllowFrom, vl as readNumberParam, vr as missingTargetError, wd as readJsonWebhookBodyOrReject, xd as beginWebhookRequestPipelineOrReject, yl as readReactionParams } from "./setup-wizard-helpers-Bds9SZeS.js";
import "./provider-env-vars-CWXfFyDU.js";
import "./logger-DEV1v8zB.js";
import "./tmp-openclaw-dir-DGafsubg.js";
import "./subsystem-BunQspj4.js";
import "./utils-C9epF7GR.js";
import "./fetch-s6LpGbVn.js";
import "./retry-Bdb5CNwD.js";
import { t as emptyPluginConfigSchema } from "./config-schema-X8cahxVt.js";
import { t as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-0CmwkA_V.js";
import "./paths-BoU0P6Xb.js";
import { c as resolveWebhookTargets, d as resolveWebhookPath, l as withResolvedWebhookRequestPipeline, n as registerWebhookTargetWithPluginRoute, o as resolveWebhookTargetWithAuthOrReject } from "./webhook-targets-DPRi3syU.js";
import { r as runPassiveAccountLifecycle, t as createAccountStatusSink } from "./channel-lifecycle-DEuCqmjW.js";
import { W as buildComputedAccountStatusSnapshot, o as GoogleChatConfigSchema, t as resolveChannelMediaMaxBytes } from "./signal-Bycwzc0M.js";
import { a as formatPairingApproveHint, n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection, u as buildChannelConfigSchema } from "./config-helpers-C9J9Kf27.js";
import "./fetch-CokEYQHV.js";
import "./exec-LHBFP7K9.js";
import "./agent-scope-BAdJcjtf.js";
import { n as applySetupAccountConfigPatch, r as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "./setup-helpers-kuIKtuQw.js";
import { C as listDirectoryGroupEntriesFromMapKeys, T as listDirectoryUserEntriesFromAllowFrom, n as createReplyPrefixOptions, u as formatDocsLink } from "./reply-prefix-B-13vT7e.js";
import "./logger-kC9I1OJ3.js";
import { t as fetchWithSsrFGuard } from "./fetch-guard-COmtEumo.js";
import "./resolve-route-5UJLanKQ.js";
import "./pairing-token-BUkoGEse.js";
import "./query-expansion-DrHj090u.js";
import "./redact-DDISwu8-.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./channel-plugin-common-cMzLzrLW.js";
import "./secret-file-B_1xic5c.js";
import { r as resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope-BE7TyEDo.js";
//#region extensions/googlechat/src/setup-core.ts
const channel$1 = "googlechat";
const googlechatSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel$1,
		accountId,
		name
	}),
	validateInput: ({ accountId, input }) => {
		if (input.useEnv && accountId !== "default") {return "GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.";}
		if (!input.useEnv && !input.token && !input.tokenFile) {return "Google Chat requires --token (service account JSON) or --token-file.";}
		return null;
	},
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const namedConfig = applyAccountNameToChannelSection({
			cfg,
			channelKey: channel$1,
			accountId,
			name: input.name
		});
		const next = accountId !== "default" ? migrateBaseNameToDefaultAccount({
			cfg: namedConfig,
			channelKey: channel$1
		}) : namedConfig;
		const patch = input.useEnv ? {} : input.tokenFile ? { serviceAccountFile: input.tokenFile } : input.token ? { serviceAccount: input.token } : {};
		const audienceType = input.audienceType?.trim();
		const audience = input.audience?.trim();
		const webhookPath = input.webhookPath?.trim();
		const webhookUrl = input.webhookUrl?.trim();
		return applySetupAccountConfigPatch({
			cfg: next,
			channelKey: channel$1,
			accountId,
			patch: {
				...patch,
				...audienceType ? { audienceType } : {},
				...audience ? { audience } : {},
				...webhookPath ? { webhookPath } : {},
				...webhookUrl ? { webhookUrl } : {}
			}
		});
	}
};
//#endregion
//#region extensions/googlechat/src/accounts.ts
const ENV_SERVICE_ACCOUNT$1 = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE$1 = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const { listAccountIds: listGoogleChatAccountIds, resolveDefaultAccountId: resolveDefaultGoogleChatAccountId } = createAccountListHelpers("googlechat");
function resolveAccountConfig(cfg, accountId) {
	const accounts = cfg.channels?.["googlechat"]?.accounts;
	if (!accounts || typeof accounts !== "object") {return;}
	return accounts[accountId];
}
function mergeGoogleChatAccountConfig(cfg, accountId) {
	const { accounts: _ignored, defaultAccount: _ignored2, ...base } = cfg.channels?.["googlechat"] ?? {};
	const defaultAccountConfig = resolveAccountConfig(cfg, "default") ?? {};
	const account = resolveAccountConfig(cfg, accountId) ?? {};
	if (accountId === "default") {return {
		...base,
		...defaultAccountConfig
	};}
	const { enabled: _ignoredEnabled, dangerouslyAllowNameMatching: _ignoredDangerouslyAllowNameMatching, serviceAccount: _ignoredServiceAccount, serviceAccountRef: _ignoredServiceAccountRef, serviceAccountFile: _ignoredServiceAccountFile, ...defaultAccountShared } = defaultAccountConfig;
	return {
		...defaultAccountShared,
		...base,
		...account
	};
}
function parseServiceAccount(value) {
	if (value && typeof value === "object") {
		if (isSecretRef(value)) {return null;}
		return value;
	}
	if (typeof value !== "string") {return null;}
	const trimmed = value.trim();
	if (!trimmed) {return null;}
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}
function resolveCredentialsFromConfig(params) {
	const { account, accountId } = params;
	const inline = parseServiceAccount(account.serviceAccount);
	if (inline) {return {
		credentials: inline,
		source: "inline"
	};}
	if (isSecretRef(account.serviceAccount)) {throw new Error(`channels.googlechat.accounts.${accountId}.serviceAccount: unresolved SecretRef "${account.serviceAccount.source}:${account.serviceAccount.provider}:${account.serviceAccount.id}". Resolve this command against an active gateway runtime snapshot before reading it.`);}
	if (isSecretRef(account.serviceAccountRef)) {throw new Error(`channels.googlechat.accounts.${accountId}.serviceAccount: unresolved SecretRef "${account.serviceAccountRef.source}:${account.serviceAccountRef.provider}:${account.serviceAccountRef.id}". Resolve this command against an active gateway runtime snapshot before reading it.`);}
	const file = account.serviceAccountFile?.trim();
	if (file) {return {
		credentialsFile: file,
		source: "file"
	};}
	if (accountId === "default") {
		const envJson = process.env[ENV_SERVICE_ACCOUNT$1];
		const envInline = parseServiceAccount(envJson);
		if (envInline) {return {
			credentials: envInline,
			source: "env"
		};}
		const envFile = process.env[ENV_SERVICE_ACCOUNT_FILE$1]?.trim();
		if (envFile) {return {
			credentialsFile: envFile,
			source: "env"
		};}
	}
	return { source: "none" };
}
function resolveGoogleChatAccount(params) {
	const accountId = normalizeAccountId(params.accountId);
	const baseEnabled = params.cfg.channels?.["googlechat"]?.enabled !== false;
	const merged = mergeGoogleChatAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const credentials = resolveCredentialsFromConfig({
		accountId,
		account: merged
	});
	return {
		accountId,
		name: merged.name?.trim() || void 0,
		enabled,
		config: merged,
		credentialSource: credentials.source,
		credentials: credentials.credentials,
		credentialsFile: credentials.credentialsFile
	};
}
//#endregion
//#region extensions/googlechat/src/setup-surface.ts
const channel = "googlechat";
const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const USE_ENV_FLAG = "__googlechatUseEnv";
const AUTH_METHOD_FLAG = "__googlechatAuthMethod";
function setGoogleChatDmPolicy(cfg, policy) {
	const allowFrom = policy === "open" ? addWildcardAllowFrom(cfg.channels?.googlechat?.dm?.allowFrom) : void 0;
	return {
		...cfg,
		channels: {
			...cfg.channels,
			googlechat: {
				...cfg.channels?.googlechat,
				dm: {
					...cfg.channels?.googlechat?.dm,
					policy,
					...allowFrom ? { allowFrom } : {}
				}
			}
		}
	};
}
async function promptAllowFrom(params) {
	const current = params.cfg.channels?.googlechat?.dm?.allowFrom ?? [];
	const entry = await params.prompter.text({
		message: "Google Chat allowFrom (users/<id> or raw email; avoid users/<email>)",
		placeholder: "users/123456789, name@example.com",
		initialValue: current[0] ? String(current[0]) : void 0,
		validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
	});
	const unique = mergeAllowFromEntries(void 0, splitSetupEntries(String(entry)));
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			googlechat: {
				...params.cfg.channels?.googlechat,
				enabled: true,
				dm: {
					...params.cfg.channels?.googlechat?.dm,
					policy: "allowlist",
					allowFrom: unique
				}
			}
		}
	};
}
const googlechatDmPolicy = {
	label: "Google Chat",
	channel,
	policyKey: "channels.googlechat.dm.policy",
	allowFromKey: "channels.googlechat.dm.allowFrom",
	getCurrent: (cfg) => cfg.channels?.googlechat?.dm?.policy ?? "pairing",
	setPolicy: (cfg, policy) => setGoogleChatDmPolicy(cfg, policy),
	promptAllowFrom
};
const googlechatSetupWizard = {
	channel,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs service account",
		configuredHint: "configured",
		unconfiguredHint: "needs auth",
		resolveConfigured: ({ cfg }) => listGoogleChatAccountIds(cfg).some((accountId) => resolveGoogleChatAccount({
			cfg,
			accountId
		}).credentialSource !== "none"),
		resolveStatusLines: ({ cfg }) => {
			return [`Google Chat: ${listGoogleChatAccountIds(cfg).some((accountId) => resolveGoogleChatAccount({
				cfg,
				accountId
			}).credentialSource !== "none") ? "configured" : "needs service account"}`];
		}
	},
	introNote: {
		title: "Google Chat setup",
		lines: [
			"Google Chat apps use service-account auth and an HTTPS webhook.",
			"Set the Chat API scopes in your service account and configure the Chat app URL.",
			"Webhook verification requires audience type + audience value.",
			`Docs: ${formatDocsLink("/channels/googlechat", "googlechat")}`
		]
	},
	prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
		if (accountId === "default" && (Boolean(process.env[ENV_SERVICE_ACCOUNT]) || Boolean(process.env[ENV_SERVICE_ACCOUNT_FILE]))) {
			if (await prompter.confirm({
				message: "Use GOOGLE_CHAT_SERVICE_ACCOUNT env vars?",
				initialValue: true
			})) {return {
				cfg: applySetupAccountConfigPatch({
					cfg,
					channelKey: channel,
					accountId,
					patch: {}
				}),
				credentialValues: {
					...credentialValues,
					[USE_ENV_FLAG]: "1"
				}
			};}
		}
		const method = await prompter.select({
			message: "Google Chat auth method",
			options: [{
				value: "file",
				label: "Service account JSON file"
			}, {
				value: "inline",
				label: "Paste service account JSON"
			}],
			initialValue: "file"
		});
		return { credentialValues: {
			...credentialValues,
			[USE_ENV_FLAG]: "0",
			[AUTH_METHOD_FLAG]: String(method)
		} };
	},
	credentials: [],
	textInputs: [{
		inputKey: "tokenFile",
		message: "Service account JSON path",
		placeholder: "/path/to/service-account.json",
		shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1" && credentialValues[AUTH_METHOD_FLAG] === "file",
		validate: ({ value }) => String(value ?? "").trim() ? void 0 : "Required",
		normalizeValue: ({ value }) => String(value).trim(),
		applySet: async ({ cfg, accountId, value }) => applySetupAccountConfigPatch({
			cfg,
			channelKey: channel,
			accountId,
			patch: { serviceAccountFile: value }
		})
	}, {
		inputKey: "token",
		message: "Service account JSON (single line)",
		placeholder: "{\"type\":\"service_account\", ... }",
		shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1" && credentialValues[AUTH_METHOD_FLAG] === "inline",
		validate: ({ value }) => String(value ?? "").trim() ? void 0 : "Required",
		normalizeValue: ({ value }) => String(value).trim(),
		applySet: async ({ cfg, accountId, value }) => applySetupAccountConfigPatch({
			cfg,
			channelKey: channel,
			accountId,
			patch: { serviceAccount: value }
		})
	}],
	finalize: async ({ cfg, accountId, prompter }) => {
		const account = resolveGoogleChatAccount({
			cfg,
			accountId
		});
		const audienceType = await prompter.select({
			message: "Webhook audience type",
			options: [{
				value: "app-url",
				label: "App URL (recommended)"
			}, {
				value: "project-number",
				label: "Project number"
			}],
			initialValue: account.config.audienceType === "project-number" ? "project-number" : "app-url"
		});
		const audience = await prompter.text({
			message: audienceType === "project-number" ? "Project number" : "App URL",
			placeholder: audienceType === "project-number" ? "1234567890" : "https://your.host/googlechat",
			initialValue: account.config.audience || void 0,
			validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
		});
		return { cfg: migrateBaseNameToDefaultAccount({
			cfg: applySetupAccountConfigPatch({
				cfg,
				channelKey: channel,
				accountId,
				patch: {
					audienceType,
					audience: String(audience).trim()
				}
			}),
			channelKey: channel
		}) };
	},
	dmPolicy: googlechatDmPolicy
};
//#endregion
export { DEFAULT_ACCOUNT_ID, GROUP_POLICY_BLOCKED_LABEL, GoogleChatConfigSchema, PAIRING_APPROVED_MESSAGE, addWildcardAllowFrom, applyAccountNameToChannelSection, applySetupAccountConfigPatch, beginWebhookRequestPipelineOrReject, buildChannelConfigSchema, buildComputedAccountStatusSnapshot, createAccountListHelpers, createAccountStatusSink, createActionGate, createReplyPrefixOptions, createScopedPairingAccess, createWebhookInFlightLimiter, deleteAccountFromConfigSection, emptyPluginConfigSchema, evaluateGroupRouteAccessForPolicy, extractToolSend, fetchWithSsrFGuard, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, googlechatSetupAdapter, googlechatSetupWizard, isDangerousNameMatchingEnabled, isSecretRef, issuePairingChallenge, jsonResult, listDirectoryGroupEntriesFromMapKeys, listDirectoryUserEntriesFromAllowFrom, mergeAllowFromEntries, migrateBaseNameToDefaultAccount, missingTargetError, normalizeAccountId, readJsonWebhookBodyOrReject, readNumberParam, readReactionParams, readStringParam, registerWebhookTargetWithPluginRoute, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDmGroupAccessWithLists, resolveGoogleChatGroupRequireMention, resolveInboundRouteEnvelopeBuilderWithRuntime, resolveMentionGatingWithBypass, resolveSenderScopedGroupPolicy, resolveWebhookPath, resolveWebhookTargetWithAuthOrReject, resolveWebhookTargets, runPassiveAccountLifecycle, setAccountEnabledInConfigSection, setTopLevelChannelDmPolicyWithAllowFrom, splitSetupEntries, warnMissingProviderGroupPolicyFallbackOnce, withResolvedWebhookRequestPipeline };
