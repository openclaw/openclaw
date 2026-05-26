import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-CwBWagLE.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { a as createSetupInputPresenceValidator } from "./setup-helpers-D1h9Zq-C.js";
import { J as setSetupChannelEnabled, Q as splitSetupEntries, a as createAllowFromSection, f as createStandardChannelSetupStatus, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Cm8y4liy.js";
import "./setup-BmF6Yxnk.js";
import { i as resolveLineAccount, n as normalizeAccountId, r as resolveDefaultLineAccountId, t as listLineAccountIds } from "./accounts-iKtrMqEn.js";
//#region extensions/line/src/account-helpers.ts
function hasLineCredentials(account) {
	return Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim());
}
function parseLineAllowFromId(raw) {
	const trimmed = raw.trim().replace(/^line:(?:user:)?/i, "");
	if (!/^U[a-f0-9]{32}$/i.test(trimmed)) return null;
	return trimmed;
}
//#endregion
//#region extensions/line/src/setup-core.ts
function patchLineAccountConfig(params) {
	const accountId = normalizeAccountId(params.accountId);
	const lineConfig = params.cfg.channels?.line ?? {};
	const clearFields = params.clearFields ?? [];
	if (accountId === "default") {
		const nextLine = { ...lineConfig };
		for (const field of clearFields) delete nextLine[field];
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				line: {
					...nextLine,
					...params.enabled ? { enabled: true } : {},
					...params.patch
				}
			}
		};
	}
	const nextAccount = { ...lineConfig.accounts?.[accountId] };
	for (const field of clearFields) delete nextAccount[field];
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			line: {
				...lineConfig,
				...params.enabled ? { enabled: true } : {},
				accounts: {
					...lineConfig.accounts,
					[accountId]: {
						...nextAccount,
						...params.enabled ? { enabled: true } : {},
						...params.patch
					}
				}
			}
		}
	};
}
function isLineConfigured(cfg, accountId) {
	return hasLineCredentials(resolveLineAccount({
		cfg,
		accountId
	}));
}
const lineSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => patchLineAccountConfig({
		cfg,
		accountId,
		patch: name?.trim() ? { name: name.trim() } : {}
	}),
	validateInput: createSetupInputPresenceValidator({
		defaultAccountOnlyEnvError: "LINE_CHANNEL_ACCESS_TOKEN can only be used for the default account.",
		whenNotUseEnv: [{
			someOf: ["channelAccessToken", "tokenFile"],
			message: "LINE requires channelAccessToken or --token-file (or --use-env)."
		}, {
			someOf: ["channelSecret", "secretFile"],
			message: "LINE requires channelSecret or --secret-file (or --use-env)."
		}]
	}),
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const typedInput = input;
		const normalizedAccountId = normalizeAccountId(accountId);
		if (normalizedAccountId === "default") return patchLineAccountConfig({
			cfg,
			accountId: normalizedAccountId,
			enabled: true,
			clearFields: typedInput.useEnv ? [
				"channelAccessToken",
				"channelSecret",
				"tokenFile",
				"secretFile"
			] : void 0,
			patch: typedInput.useEnv ? {} : {
				...typedInput.tokenFile ? { tokenFile: typedInput.tokenFile } : typedInput.channelAccessToken ? { channelAccessToken: typedInput.channelAccessToken } : {},
				...typedInput.secretFile ? { secretFile: typedInput.secretFile } : typedInput.channelSecret ? { channelSecret: typedInput.channelSecret } : {}
			}
		});
		return patchLineAccountConfig({
			cfg,
			accountId: normalizedAccountId,
			enabled: true,
			patch: {
				...typedInput.tokenFile ? { tokenFile: typedInput.tokenFile } : typedInput.channelAccessToken ? { channelAccessToken: typedInput.channelAccessToken } : {},
				...typedInput.secretFile ? { secretFile: typedInput.secretFile } : typedInput.channelSecret ? { channelSecret: typedInput.channelSecret } : {}
			}
		});
	}
};
//#endregion
//#region extensions/line/src/setup-surface.ts
const channel = "line";
const LINE_SETUP_HELP_LINES = [
	"1) Open the LINE Developers Console and create or pick a Messaging API channel",
	"2) Copy the channel access token and channel secret",
	"3) Enable Use webhook in the Messaging API settings",
	"4) Point the webhook at https://<gateway-host>/line/webhook",
	`Docs: ${formatDocsLink("/channels/line", "channels/line")}`
];
const LINE_ALLOW_FROM_HELP_LINES = [
	"Allowlist LINE DMs by user id.",
	"LINE ids are case-sensitive.",
	"Examples:",
	"- U1234567890abcdef1234567890abcdef",
	"- line:user:U1234567890abcdef1234567890abcdef",
	"Multiple entries: comma-separated.",
	`Docs: ${formatDocsLink("/channels/line", "channels/line")}`
];
const lineDmPolicy = {
	label: "LINE",
	channel,
	policyKey: "channels.line.dmPolicy",
	allowFromKey: "channels.line.allowFrom",
	resolveConfigKeys: (cfg, accountId) => (accountId ?? resolveDefaultLineAccountId(cfg)) !== "default" ? {
		policyKey: `channels.line.accounts.${accountId ?? resolveDefaultLineAccountId(cfg)}.dmPolicy`,
		allowFromKey: `channels.line.accounts.${accountId ?? resolveDefaultLineAccountId(cfg)}.allowFrom`
	} : {
		policyKey: "channels.line.dmPolicy",
		allowFromKey: "channels.line.allowFrom"
	},
	getCurrent: (cfg, accountId) => resolveLineAccount({
		cfg,
		accountId: accountId ?? resolveDefaultLineAccountId(cfg)
	}).config.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy, accountId) => patchLineAccountConfig({
		cfg,
		accountId: accountId ?? resolveDefaultLineAccountId(cfg),
		enabled: true,
		patch: policy === "open" ? {
			dmPolicy: "open",
			allowFrom: mergeAllowFromEntries(resolveLineAccount({
				cfg,
				accountId: accountId ?? resolveDefaultLineAccountId(cfg)
			}).config.allowFrom, ["*"])
		} : { dmPolicy: policy },
		clearFields: policy === "pairing" || policy === "disabled" ? ["allowFrom"] : void 0
	})
};
const lineSetupWizard = {
	channel,
	status: createStandardChannelSetupStatus({
		channelLabel: "LINE",
		configuredLabel: "configured",
		unconfiguredLabel: "needs token + secret",
		configuredHint: "configured",
		unconfiguredHint: "needs token + secret",
		configuredScore: 1,
		unconfiguredScore: 0,
		includeStatusLine: true,
		resolveConfigured: ({ cfg, accountId }) => isLineConfigured(cfg, accountId ?? resolveDefaultLineAccountId(cfg)),
		resolveExtraStatusLines: ({ cfg }) => [`Accounts: ${listLineAccountIds(cfg).length || 0}`]
	}),
	introNote: {
		title: "LINE Messaging API",
		lines: LINE_SETUP_HELP_LINES,
		shouldShow: ({ cfg, accountId }) => !isLineConfigured(cfg, accountId ?? resolveDefaultLineAccountId(cfg))
	},
	credentials: [{
		inputKey: "token",
		providerHint: channel,
		credentialLabel: "channel access token",
		preferredEnvVar: "LINE_CHANNEL_ACCESS_TOKEN",
		helpTitle: "LINE Messaging API",
		helpLines: LINE_SETUP_HELP_LINES,
		envPrompt: "LINE_CHANNEL_ACCESS_TOKEN detected. Use env var?",
		keepPrompt: "LINE channel access token already configured. Keep it?",
		inputPrompt: "Enter LINE channel access token",
		allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
		inspect: ({ cfg, accountId }) => {
			const resolved = resolveLineAccount({
				cfg,
				accountId
			});
			return {
				accountConfigured: Boolean(normalizeOptionalString(resolved.channelAccessToken) && normalizeOptionalString(resolved.channelSecret)),
				hasConfiguredValue: Boolean(normalizeOptionalString(resolved.config.channelAccessToken) ?? normalizeOptionalString(resolved.config.tokenFile)),
				resolvedValue: normalizeOptionalString(resolved.channelAccessToken),
				envValue: accountId === "default" ? normalizeOptionalString(process.env.LINE_CHANNEL_ACCESS_TOKEN) : void 0
			};
		},
		applyUseEnv: ({ cfg, accountId }) => patchLineAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: ["channelAccessToken", "tokenFile"],
			patch: {}
		}),
		applySet: ({ cfg, accountId, resolvedValue }) => patchLineAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: ["tokenFile"],
			patch: { channelAccessToken: resolvedValue }
		})
	}, {
		inputKey: "password",
		providerHint: "line-secret",
		credentialLabel: "channel secret",
		preferredEnvVar: "LINE_CHANNEL_SECRET",
		helpTitle: "LINE Messaging API",
		helpLines: LINE_SETUP_HELP_LINES,
		envPrompt: "LINE_CHANNEL_SECRET detected. Use env var?",
		keepPrompt: "LINE channel secret already configured. Keep it?",
		inputPrompt: "Enter LINE channel secret",
		allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
		inspect: ({ cfg, accountId }) => {
			const resolved = resolveLineAccount({
				cfg,
				accountId
			});
			return {
				accountConfigured: Boolean(normalizeOptionalString(resolved.channelAccessToken) && normalizeOptionalString(resolved.channelSecret)),
				hasConfiguredValue: Boolean(normalizeOptionalString(resolved.config.channelSecret) ?? normalizeOptionalString(resolved.config.secretFile)),
				resolvedValue: normalizeOptionalString(resolved.channelSecret),
				envValue: accountId === "default" ? normalizeOptionalString(process.env.LINE_CHANNEL_SECRET) : void 0
			};
		},
		applyUseEnv: ({ cfg, accountId }) => patchLineAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: ["channelSecret", "secretFile"],
			patch: {}
		}),
		applySet: ({ cfg, accountId, resolvedValue }) => patchLineAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: ["secretFile"],
			patch: { channelSecret: resolvedValue }
		})
	}],
	allowFrom: createAllowFromSection({
		helpTitle: "LINE allowlist",
		helpLines: LINE_ALLOW_FROM_HELP_LINES,
		message: "LINE allowFrom (user id)",
		placeholder: "U1234567890abcdef1234567890abcdef",
		invalidWithoutCredentialNote: "LINE allowFrom requires raw user ids like U1234567890abcdef1234567890abcdef.",
		parseInputs: splitSetupEntries,
		parseId: parseLineAllowFromId,
		apply: ({ cfg, accountId, allowFrom }) => patchLineAccountConfig({
			cfg,
			accountId,
			enabled: true,
			patch: {
				dmPolicy: "allowlist",
				allowFrom
			}
		})
	}),
	dmPolicy: lineDmPolicy,
	completionNote: {
		title: "LINE webhook",
		lines: [
			"Enable Use webhook in the LINE console after saving credentials.",
			"Default webhook URL: https://<gateway-host>/line/webhook",
			"If you set channels.line.webhookPath, update the URL to match.",
			`Docs: ${formatDocsLink("/channels/line", "channels/line")}`
		]
	},
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
};
//#endregion
export { lineSetupAdapter as n, hasLineCredentials as r, lineSetupWizard as t };
