import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as createSetupInputPresenceValidator } from "./setup-helpers-BC9z9VvG.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { J as setSetupChannelEnabled, Q as splitSetupEntries, a as createAllowFromSection, f as createStandardChannelSetupStatus, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Dbpzm32P.js";
import "./setup-DPvocg6M.js";
import { i as resolveLineAccount, n as normalizeAccountId, r as resolveDefaultLineAccountId, t as listLineAccountIds } from "./accounts-B7VHf02h.js";
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
const t = createSetupTranslator();
const channel = "line";
const LINE_SETUP_HELP_LINES = [
	t("wizard.line.helpOpenConsole"),
	t("wizard.line.helpCopyCredentials"),
	t("wizard.line.helpEnableWebhook"),
	t("wizard.line.helpWebhookUrl"),
	t("wizard.channels.docs", { link: formatDocsLink("/channels/line", "channels/line") })
];
const LINE_ALLOW_FROM_HELP_LINES = [
	t("wizard.line.allowlistIntro"),
	t("wizard.line.idsCaseSensitive"),
	t("wizard.line.examples"),
	"- U1234567890abcdef1234567890abcdef",
	"- line:user:U1234567890abcdef1234567890abcdef",
	t("wizard.line.multipleEntries"),
	t("wizard.channels.docs", { link: formatDocsLink("/channels/line", "channels/line") })
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
		configuredLabel: t("wizard.channels.statusConfigured"),
		unconfiguredLabel: t("wizard.channels.statusNeedsTokenSecret"),
		configuredHint: t("wizard.channels.statusConfigured"),
		unconfiguredHint: t("wizard.channels.statusNeedsTokenSecret"),
		configuredScore: 1,
		unconfiguredScore: 0,
		includeStatusLine: true,
		resolveConfigured: ({ cfg, accountId }) => isLineConfigured(cfg, accountId ?? resolveDefaultLineAccountId(cfg)),
		resolveExtraStatusLines: ({ cfg }) => [`Accounts: ${listLineAccountIds(cfg).length || 0}`]
	}),
	introNote: {
		title: t("wizard.line.messagingApiTitle"),
		lines: LINE_SETUP_HELP_LINES,
		shouldShow: ({ cfg, accountId }) => !isLineConfigured(cfg, accountId ?? resolveDefaultLineAccountId(cfg))
	},
	credentials: [{
		inputKey: "token",
		providerHint: channel,
		credentialLabel: t("wizard.line.channelAccessToken"),
		preferredEnvVar: "LINE_CHANNEL_ACCESS_TOKEN",
		helpTitle: t("wizard.line.messagingApiTitle"),
		helpLines: LINE_SETUP_HELP_LINES,
		envPrompt: t("wizard.line.tokenEnvPrompt"),
		keepPrompt: t("wizard.line.tokenKeepPrompt"),
		inputPrompt: t("wizard.line.tokenInputPrompt"),
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
		credentialLabel: t("wizard.line.channelSecret"),
		preferredEnvVar: "LINE_CHANNEL_SECRET",
		helpTitle: t("wizard.line.messagingApiTitle"),
		helpLines: LINE_SETUP_HELP_LINES,
		envPrompt: t("wizard.line.secretEnvPrompt"),
		keepPrompt: t("wizard.line.secretKeepPrompt"),
		inputPrompt: t("wizard.line.secretInputPrompt"),
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
		helpTitle: t("wizard.line.allowlistTitle"),
		helpLines: LINE_ALLOW_FROM_HELP_LINES,
		message: t("wizard.line.allowFromPrompt"),
		placeholder: "U1234567890abcdef1234567890abcdef",
		invalidWithoutCredentialNote: t("wizard.line.allowFromInvalid"),
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
		title: t("wizard.line.webhookTitle"),
		lines: [
			t("wizard.line.completionEnableWebhook"),
			t("wizard.line.completionDefaultWebhook"),
			t("wizard.line.completionWebhookPath"),
			t("wizard.channels.docs", { link: formatDocsLink("/channels/line", "channels/line") })
		]
	},
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
};
//#endregion
export { lineSetupAdapter as n, hasLineCredentials as r, lineSetupWizard as t };
