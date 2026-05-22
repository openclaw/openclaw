import { c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as formatDocsLink } from "./links-BszRQhGa.js";
import { s as isSecretRef } from "./types.secrets-CyuYZNvB.js";
import { n as safeParseWithSchema, t as safeParseJsonWithSchema } from "./zod-parse-CnyYByY3.js";
import { n as normalizeAccountId } from "./account-id-DUpVOe8L.js";
import { t as resolveAccountEntry } from "./account-lookup-IHwT3A43.js";
import "./text-runtime-icMZVCaq.js";
import { s as resolveMergedAccountConfig, t as createAccountListHelpers } from "./account-helpers-CTA0ZNCv.js";
import { a as createSetupInputPresenceValidator, i as createPatchedAccountSetupAdapter, n as applySetupAccountConfigPatch, s as migrateBaseNameToDefaultAccount } from "./setup-helpers-t5I1EDve.js";
import "./secret-input-D0IRWu80.js";
import { Q as splitSetupEntries, d as createPromptParsedAllowFromForAccount, f as createStandardChannelSetupStatus, t as addWildcardAllowFrom, v as mergeAllowFromEntries } from "./setup-wizard-helpers-D8cUTbTq.js";
import "./setup-C421YIRA.js";
import "./setup-runtime-DnzDKo4B.js";
import "./account-resolution-Cb_on3KT.js";
import "./extension-shared-CGFuE4qV.js";
import { z } from "zod";
//#region extensions/googlechat/src/accounts.ts
const ENV_SERVICE_ACCOUNT$1 = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE$1 = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const JsonRecordSchema = z.record(z.string(), z.unknown());
const { listAccountIds: listGoogleChatAccountIds, resolveDefaultAccountId: resolveDefaultGoogleChatAccountId } = createAccountListHelpers("googlechat");
function mergeGoogleChatAccountConfig(cfg, accountId) {
	const raw = cfg.channels?.["googlechat"] ?? {};
	const base = resolveMergedAccountConfig({
		channelConfig: raw,
		accounts: raw.accounts,
		accountId,
		omitKeys: ["defaultAccount"]
	});
	const defaultAccountConfig = resolveAccountEntry(raw.accounts, "default") ?? {};
	if (accountId === "default") return base;
	const { enabled: _ignoredEnabled, dangerouslyAllowNameMatching: _ignoredDangerouslyAllowNameMatching, serviceAccount: _ignoredServiceAccount, serviceAccountRef: _ignoredServiceAccountRef, serviceAccountFile: _ignoredServiceAccountFile, ...defaultAccountShared } = defaultAccountConfig;
	return {
		...defaultAccountShared,
		...base
	};
}
function resolveGoogleChatConfigAccessorAccount(params) {
	const accountId = normalizeAccountId(params.accountId ?? params.cfg.channels?.googlechat?.defaultAccount);
	return { config: mergeGoogleChatAccountConfig(params.cfg, accountId) };
}
function parseServiceAccount(value) {
	if (isSecretRef(value)) return null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return null;
		return safeParseJsonWithSchema(JsonRecordSchema, trimmed);
	}
	return safeParseWithSchema(JsonRecordSchema, value);
}
function resolveCredentialsFromConfig(params) {
	const { account, accountId } = params;
	const inline = parseServiceAccount(account.serviceAccount);
	if (inline) return {
		credentials: inline,
		source: "inline"
	};
	if (isSecretRef(account.serviceAccount)) throw new Error(`channels.googlechat.accounts.${accountId}.serviceAccount: unresolved SecretRef "${account.serviceAccount.source}:${account.serviceAccount.provider}:${account.serviceAccount.id}". Resolve this command against an active gateway runtime snapshot before reading it.`);
	if (isSecretRef(account.serviceAccountRef)) throw new Error(`channels.googlechat.accounts.${accountId}.serviceAccount: unresolved SecretRef "${account.serviceAccountRef.source}:${account.serviceAccountRef.provider}:${account.serviceAccountRef.id}". Resolve this command against an active gateway runtime snapshot before reading it.`);
	const file = normalizeOptionalString(account.serviceAccountFile);
	if (file) return {
		credentialsFile: file,
		source: "file"
	};
	if (accountId === "default") {
		const envJson = process.env[ENV_SERVICE_ACCOUNT$1];
		const envInline = parseServiceAccount(envJson);
		if (envInline) return {
			credentials: envInline,
			source: "env"
		};
		const envFile = normalizeOptionalString(process.env[ENV_SERVICE_ACCOUNT_FILE$1]);
		if (envFile) return {
			credentialsFile: envFile,
			source: "env"
		};
	}
	return { source: "none" };
}
function resolveGoogleChatAccount(params) {
	const accountId = normalizeAccountId(params.accountId ?? params.cfg.channels?.["googlechat"]?.defaultAccount);
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
		name: normalizeOptionalString(merged.name),
		enabled,
		config: merged,
		credentialSource: credentials.source,
		credentials: credentials.credentials,
		credentialsFile: credentials.credentialsFile
	};
}
function listEnabledGoogleChatAccounts(cfg) {
	return listGoogleChatAccountIds(cfg).map((accountId) => resolveGoogleChatAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}
const googlechatSetupAdapter = createPatchedAccountSetupAdapter({
	channelKey: "googlechat",
	validateInput: createSetupInputPresenceValidator({
		defaultAccountOnlyEnvError: "GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.",
		whenNotUseEnv: [{
			someOf: ["token", "tokenFile"],
			message: "Google Chat requires --token (service account JSON) or --token-file."
		}]
	}),
	buildPatch: (input) => {
		const patch = input.useEnv ? {} : input.tokenFile ? { serviceAccountFile: input.tokenFile } : input.token ? { serviceAccount: input.token } : {};
		const audienceType = input.audienceType?.trim();
		const audience = input.audience?.trim();
		const webhookPath = input.webhookPath?.trim();
		const webhookUrl = input.webhookUrl?.trim();
		return {
			...patch,
			...audienceType ? { audienceType } : {},
			...audience ? { audience } : {},
			...webhookPath ? { webhookPath } : {},
			...webhookUrl ? { webhookUrl } : {}
		};
	}
});
//#endregion
//#region extensions/googlechat/src/setup-surface.ts
const channel = "googlechat";
const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const USE_ENV_FLAG = "__googlechatUseEnv";
const AUTH_METHOD_FLAG = "__googlechatAuthMethod";
const googlechatDmPolicy = {
	label: "Google Chat",
	channel,
	policyKey: "channels.googlechat.dm.policy",
	allowFromKey: "channels.googlechat.dm.allowFrom",
	resolveConfigKeys: (cfg, accountId) => (accountId ?? resolveDefaultGoogleChatAccountId(cfg)) !== "default" ? {
		policyKey: `channels.googlechat.accounts.${accountId ?? resolveDefaultGoogleChatAccountId(cfg)}.dm.policy`,
		allowFromKey: `channels.googlechat.accounts.${accountId ?? resolveDefaultGoogleChatAccountId(cfg)}.dm.allowFrom`
	} : {
		policyKey: "channels.googlechat.dm.policy",
		allowFromKey: "channels.googlechat.dm.allowFrom"
	},
	getCurrent: (cfg, accountId) => resolveGoogleChatAccount({
		cfg,
		accountId: accountId ?? resolveDefaultGoogleChatAccountId(cfg)
	}).config.dm?.policy ?? "pairing",
	setPolicy: (cfg, policy, accountId) => {
		const resolvedAccountId = accountId ?? resolveDefaultGoogleChatAccountId(cfg);
		const currentDm = resolveGoogleChatAccount({
			cfg,
			accountId: resolvedAccountId
		}).config.dm;
		return applySetupAccountConfigPatch({
			cfg,
			channelKey: channel,
			accountId: resolvedAccountId,
			patch: { dm: {
				...currentDm,
				policy,
				...policy === "open" ? { allowFrom: addWildcardAllowFrom(currentDm?.allowFrom) } : {}
			} }
		});
	},
	promptAllowFrom: createPromptParsedAllowFromForAccount({
		defaultAccountId: resolveDefaultGoogleChatAccountId,
		message: "Google Chat allowFrom (users/<id> or raw email; avoid users/<email>)",
		placeholder: "users/123456789, name@example.com",
		parseEntries: (raw) => ({ entries: mergeAllowFromEntries(void 0, splitSetupEntries(raw)) }),
		getExistingAllowFrom: ({ cfg, accountId }) => resolveGoogleChatAccount({
			cfg,
			accountId
		}).config.dm?.allowFrom ?? [],
		applyAllowFrom: ({ cfg, accountId, allowFrom }) => applySetupAccountConfigPatch({
			cfg,
			channelKey: channel,
			accountId,
			patch: { dm: {
				...resolveGoogleChatAccount({
					cfg,
					accountId
				}).config.dm,
				allowFrom
			} }
		})
	})
};
function createServiceAccountTextInput(params) {
	return {
		inputKey: params.inputKey,
		message: params.message,
		placeholder: params.placeholder,
		shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1" && credentialValues[AUTH_METHOD_FLAG] === params.authMethod,
		validate: ({ value }) => normalizeStringifiedOptionalString(value) ? void 0 : "Required",
		normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
		applySet: async ({ cfg, accountId, value }) => applySetupAccountConfigPatch({
			cfg,
			channelKey: channel,
			accountId,
			patch: { [params.patchKey]: value }
		})
	};
}
const googlechatSetupWizard = {
	channel,
	status: createStandardChannelSetupStatus({
		channelLabel: "Google Chat",
		configuredLabel: "configured",
		unconfiguredLabel: "needs service account",
		configuredHint: "configured",
		unconfiguredHint: "needs auth",
		includeStatusLine: true,
		resolveConfigured: ({ cfg, accountId }) => resolveGoogleChatAccount({
			cfg,
			accountId
		}).credentialSource !== "none"
	}),
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
			})) return {
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
			};
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
			[AUTH_METHOD_FLAG]: method
		} };
	},
	credentials: [],
	textInputs: [createServiceAccountTextInput({
		inputKey: "tokenFile",
		message: "Service account JSON path",
		placeholder: "/path/to/service-account.json",
		authMethod: "file",
		patchKey: "serviceAccountFile"
	}), createServiceAccountTextInput({
		inputKey: "token",
		message: "Service account JSON (single line)",
		placeholder: "{\"type\":\"service_account\", ... }",
		authMethod: "inline",
		patchKey: "serviceAccount"
	})],
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
		return { cfg: migrateBaseNameToDefaultAccount({
			cfg: applySetupAccountConfigPatch({
				cfg,
				channelKey: channel,
				accountId,
				patch: {
					audienceType,
					audience: normalizeOptionalString(await prompter.text({
						message: audienceType === "project-number" ? "Project number" : "App URL",
						placeholder: audienceType === "project-number" ? "1234567890" : "https://your.host/googlechat",
						initialValue: account.config.audience || void 0,
						validate: (value) => normalizeStringifiedOptionalString(value) ? void 0 : "Required"
					})) ?? ""
				}
			}),
			channelKey: channel
		}) };
	},
	dmPolicy: googlechatDmPolicy
};
//#endregion
export { resolveDefaultGoogleChatAccountId as a, listGoogleChatAccountIds as i, googlechatSetupAdapter as n, resolveGoogleChatAccount as o, listEnabledGoogleChatAccounts as r, resolveGoogleChatConfigAccessorAccount as s, googlechatSetupWizard as t };
