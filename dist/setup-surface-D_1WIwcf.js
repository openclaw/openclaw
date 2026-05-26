import { c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import "./account-id-CwBWagLE.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { a as createSetupInputPresenceValidator, i as createPatchedAccountSetupAdapter, n as applySetupAccountConfigPatch, s as migrateBaseNameToDefaultAccount } from "./setup-helpers-D1h9Zq-C.js";
import { Q as splitSetupEntries, d as createPromptParsedAllowFromForAccount, f as createStandardChannelSetupStatus, t as addWildcardAllowFrom, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Cm8y4liy.js";
import "./setup-BmF6Yxnk.js";
import "./setup-runtime-hbbN9wHP.js";
import { i as resolveGoogleChatAccount, r as resolveDefaultGoogleChatAccountId } from "./accounts-BXtoSQY_.js";
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
export { googlechatSetupAdapter as n, googlechatSetupWizard as t };
