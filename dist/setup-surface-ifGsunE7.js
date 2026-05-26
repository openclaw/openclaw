import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as listCombinedAccountIds, c as resolveMergedAccountConfig } from "./account-helpers-BEXOONiv.js";
import { r as resolveDangerousNameMatchingEnabled } from "./dangerous-name-matching-jjAiM0PK.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { J as setSetupChannelEnabled, Q as splitSetupEntries, a as createAllowFromSection, f as createStandardChannelSetupStatus, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Dbpzm32P.js";
import "./setup-DPvocg6M.js";
import "./account-resolution-Dy8RKAMt.js";
//#region extensions/synology-chat/src/accounts.ts
/**
* Account resolution: reads config from channels.synology-chat,
* merges per-account overrides, falls back to environment variables.
*/
/** Extract the channel config from the full OpenClaw config object. */
function getChannelConfig$1(cfg) {
	return cfg?.channels?.["synology-chat"];
}
function resolveImplicitAccountId(channelCfg) {
	return channelCfg.token || process.env.SYNOLOGY_CHAT_TOKEN ? DEFAULT_ACCOUNT_ID : void 0;
}
function getRawAccountConfig$1(channelCfg, accountId) {
	if (accountId === "default") return channelCfg;
	return channelCfg.accounts?.[accountId] ?? {};
}
function hasExplicitWebhookPath(rawAccount) {
	return typeof rawAccount?.webhookPath === "string" && rawAccount.webhookPath.trim().length > 0;
}
function resolveWebhookPathSource(params) {
	if (hasExplicitWebhookPath(params.rawAccount)) return "explicit";
	if (params.accountId !== "default" && hasExplicitWebhookPath(params.channelCfg)) return "inherited-base";
	return "default";
}
/** Parse allowedUserIds from string or array to string[]. */
function parseAllowedUserIds(raw) {
	if (!raw) return [];
	if (Array.isArray(raw)) return raw.filter(Boolean);
	return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function parseRateLimitPerMinute(raw) {
	if (raw == null) return 30;
	const trimmed = raw.trim();
	if (!/^-?\d+$/.test(trimmed)) return 30;
	return Number.parseInt(trimmed, 10);
}
/**
* List all configured account IDs for this channel.
* Returns ["default"] if there's a base config, plus any named accounts.
*/
function listAccountIds(cfg) {
	const channelCfg = getChannelConfig$1(cfg);
	if (!channelCfg) return [];
	return listCombinedAccountIds({
		configuredAccountIds: Object.keys(channelCfg.accounts ?? {}),
		implicitAccountId: resolveImplicitAccountId(channelCfg)
	});
}
/**
* Resolve a specific account by ID with full defaults applied.
* Falls back to env vars for the "default" account.
*/
function resolveAccount(cfg, accountId) {
	const channelCfg = getChannelConfig$1(cfg) ?? {};
	const id = accountId || "default";
	const accountOverrides = id === "default" ? void 0 : channelCfg.accounts?.[id] ?? void 0;
	const rawAccount = getRawAccountConfig$1(channelCfg, id);
	const merged = resolveMergedAccountConfig({
		channelConfig: channelCfg,
		accounts: channelCfg.accounts,
		accountId: id
	});
	const envToken = process.env.SYNOLOGY_CHAT_TOKEN ?? "";
	const envIncomingUrl = process.env.SYNOLOGY_CHAT_INCOMING_URL ?? "";
	const envNasHost = process.env.SYNOLOGY_NAS_HOST ?? "localhost";
	const envAllowedUserIds = process.env.SYNOLOGY_ALLOWED_USER_IDS ?? "";
	const envRateLimitValue = parseRateLimitPerMinute(process.env.SYNOLOGY_RATE_LIMIT);
	const envBotName = process.env.OPENCLAW_BOT_NAME ?? "OpenClaw";
	const webhookPathSource = resolveWebhookPathSource({
		accountId: id,
		channelCfg,
		rawAccount
	});
	const dangerouslyAllowInheritedWebhookPath = rawAccount.dangerouslyAllowInheritedWebhookPath ?? channelCfg.dangerouslyAllowInheritedWebhookPath ?? false;
	return {
		accountId: id,
		enabled: merged.enabled ?? true,
		token: merged.token ?? envToken,
		incomingUrl: merged.incomingUrl ?? envIncomingUrl,
		nasHost: merged.nasHost ?? envNasHost,
		webhookPath: merged.webhookPath ?? "/webhook/synology",
		webhookPathSource,
		dangerouslyAllowNameMatching: resolveDangerousNameMatchingEnabled({
			providerConfig: channelCfg,
			accountConfig: accountOverrides
		}),
		dangerouslyAllowInheritedWebhookPath,
		dmPolicy: merged.dmPolicy ?? "allowlist",
		allowedUserIds: parseAllowedUserIds(merged.allowedUserIds ?? envAllowedUserIds),
		rateLimitPerMinute: merged.rateLimitPerMinute ?? envRateLimitValue,
		botName: merged.botName ?? envBotName,
		allowInsecureSsl: merged.allowInsecureSsl ?? false
	};
}
//#endregion
//#region extensions/synology-chat/src/setup-surface.ts
const t = createSetupTranslator();
const channel = "synology-chat";
const DEFAULT_WEBHOOK_PATH = "/webhook/synology";
const SYNOLOGY_SETUP_HELP_LINES = [
	t("wizard.synologyChat.helpIncomingWebhook"),
	t("wizard.synologyChat.helpOutgoingWebhook"),
	t("wizard.synologyChat.helpPointWebhook", { path: DEFAULT_WEBHOOK_PATH }),
	t("wizard.synologyChat.helpAllowedUsers"),
	`Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`
];
const SYNOLOGY_ALLOW_FROM_HELP_LINES = [
	t("wizard.synologyChat.allowlistIntro"),
	t("wizard.synologyChat.examples"),
	"- 123456",
	"- synology-chat:123456",
	t("wizard.synologyChat.multipleEntries"),
	`Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`
];
function getChannelConfig(cfg) {
	return cfg.channels?.[channel] ?? {};
}
function getRawAccountConfig(cfg, accountId) {
	const channelConfig = getChannelConfig(cfg);
	if (accountId === "default") return channelConfig;
	return channelConfig.accounts?.[accountId] ?? {};
}
function patchSynologyChatAccountConfig(params) {
	const channelConfig = getChannelConfig(params.cfg);
	if (params.accountId === "default") {
		const nextChannelConfig = { ...channelConfig };
		for (const field of params.clearFields ?? []) delete nextChannelConfig[field];
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[channel]: {
					...nextChannelConfig,
					...params.enabled ? { enabled: true } : {},
					...params.patch
				}
			}
		};
	}
	const nextAccounts = { ...channelConfig.accounts };
	const nextAccountConfig = { ...nextAccounts[params.accountId] };
	for (const field of params.clearFields ?? []) delete nextAccountConfig[field];
	nextAccounts[params.accountId] = {
		...nextAccountConfig,
		...params.enabled ? { enabled: true } : {},
		...params.patch
	};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[channel]: {
				...channelConfig,
				...params.enabled ? { enabled: true } : {},
				accounts: nextAccounts
			}
		}
	};
}
function isSynologyChatConfigured(cfg, accountId) {
	const account = resolveAccount(cfg, accountId);
	return Boolean(account.token.trim() && account.incomingUrl.trim());
}
function validateWebhookUrl(value) {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Incoming webhook must use http:// or https://.";
	} catch {
		return "Incoming webhook must be a valid URL.";
	}
}
function validateWebhookPath(value) {
	const trimmed = value.trim();
	if (!trimmed) return;
	return trimmed.startsWith("/") ? void 0 : "Webhook path must start with /.";
}
function parseSynologyUserId(value) {
	const cleaned = value.replace(/^synology(?:[-_]?chat)?:/i, "").trim();
	return /^\d+$/.test(cleaned) ? cleaned : null;
}
function normalizeSynologyAllowedUserId(value) {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return `${value}`.trim();
	return "";
}
function resolveExistingAllowedUserIds(cfg, accountId) {
	const raw = getRawAccountConfig(cfg, accountId).allowedUserIds;
	if (Array.isArray(raw)) return raw.map(normalizeSynologyAllowedUserId).filter(Boolean);
	return normalizeSynologyAllowedUserId(raw).split(",").map((value) => value.trim()).filter(Boolean);
}
const synologyChatSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) ?? "default",
	validateInput: ({ accountId, input }) => {
		if (input.useEnv && accountId !== "default") return "Synology Chat env credentials only support the default account.";
		if (!input.useEnv && !input.token?.trim()) return "Synology Chat requires --token or --use-env.";
		if (!input.url?.trim()) return "Synology Chat requires --url for the incoming webhook.";
		const urlError = validateWebhookUrl(input.url.trim());
		if (urlError) return urlError;
		if (input.webhookPath?.trim()) return validateWebhookPath(input.webhookPath.trim()) ?? null;
		return null;
	},
	applyAccountConfig: ({ cfg, accountId, input }) => patchSynologyChatAccountConfig({
		cfg,
		accountId,
		enabled: true,
		clearFields: input.useEnv ? ["token"] : void 0,
		patch: {
			...input.useEnv ? {} : { token: input.token?.trim() },
			incomingUrl: input.url?.trim(),
			...input.webhookPath?.trim() ? { webhookPath: input.webhookPath.trim() } : {}
		}
	})
};
const synologyChatSetupWizard = {
	channel,
	status: createStandardChannelSetupStatus({
		channelLabel: "Synology Chat",
		configuredLabel: t("wizard.channels.statusConfigured"),
		unconfiguredLabel: t("wizard.channels.statusNeedsTokenIncomingWebhook"),
		configuredHint: t("wizard.channels.statusConfigured"),
		unconfiguredHint: t("wizard.channels.statusNeedsTokenIncomingWebhook"),
		configuredScore: 1,
		unconfiguredScore: 0,
		includeStatusLine: true,
		resolveConfigured: ({ cfg, accountId }) => accountId ? isSynologyChatConfigured(cfg, accountId) : listAccountIds(cfg).some((candidateAccountId) => isSynologyChatConfigured(cfg, candidateAccountId)),
		resolveExtraStatusLines: ({ cfg }) => [`Accounts: ${listAccountIds(cfg).length || 0}`]
	}),
	introNote: {
		title: t("wizard.synologyChat.setupTitle"),
		lines: SYNOLOGY_SETUP_HELP_LINES
	},
	credentials: [{
		inputKey: "token",
		providerHint: channel,
		credentialLabel: "outgoing webhook token",
		preferredEnvVar: "SYNOLOGY_CHAT_TOKEN",
		helpTitle: t("wizard.synologyChat.webhookTokenTitle"),
		helpLines: SYNOLOGY_SETUP_HELP_LINES,
		envPrompt: t("wizard.synologyChat.tokenEnvPrompt"),
		keepPrompt: t("wizard.synologyChat.tokenKeep"),
		inputPrompt: t("wizard.synologyChat.tokenInput"),
		allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
		inspect: ({ cfg, accountId }) => {
			const account = resolveAccount(cfg, accountId);
			const raw = getRawAccountConfig(cfg, accountId);
			return {
				accountConfigured: isSynologyChatConfigured(cfg, accountId),
				hasConfiguredValue: Boolean(normalizeOptionalString(raw.token)),
				resolvedValue: normalizeOptionalString(account.token),
				envValue: accountId === "default" ? normalizeOptionalString(process.env.SYNOLOGY_CHAT_TOKEN) : void 0
			};
		},
		applyUseEnv: async ({ cfg, accountId }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: ["token"],
			patch: {}
		}),
		applySet: async ({ cfg, accountId, resolvedValue }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			patch: { token: resolvedValue }
		})
	}],
	textInputs: [{
		inputKey: "url",
		message: t("wizard.synologyChat.incomingWebhookUrlPrompt"),
		placeholder: "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming...",
		helpTitle: t("wizard.synologyChat.incomingWebhookTitle"),
		helpLines: [t("wizard.synologyChat.incomingWebhookHelpUseUrl"), t("wizard.synologyChat.incomingWebhookHelpReplies")],
		currentValue: ({ cfg, accountId }) => getRawAccountConfig(cfg, accountId).incomingUrl?.trim(),
		keepPrompt: (value) => t("wizard.synologyChat.incomingWebhookKeep", { value }),
		validate: ({ value }) => validateWebhookUrl(value),
		applySet: async ({ cfg, accountId, value }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			patch: { incomingUrl: value.trim() }
		})
	}, {
		inputKey: "webhookPath",
		message: t("wizard.synologyChat.outgoingWebhookPathPrompt"),
		placeholder: DEFAULT_WEBHOOK_PATH,
		required: false,
		applyEmptyValue: true,
		helpTitle: t("wizard.synologyChat.outgoingWebhookPathTitle"),
		helpLines: [t("wizard.synologyChat.defaultPath", { path: DEFAULT_WEBHOOK_PATH }), t("wizard.synologyChat.outgoingWebhookPathHelp")],
		currentValue: ({ cfg, accountId }) => getRawAccountConfig(cfg, accountId).webhookPath?.trim(),
		keepPrompt: (value) => t("wizard.synologyChat.outgoingWebhookPathKeep", { value }),
		validate: ({ value }) => validateWebhookPath(value),
		applySet: async ({ cfg, accountId, value }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: value.trim() ? void 0 : ["webhookPath"],
			patch: value.trim() ? { webhookPath: value.trim() } : {}
		})
	}],
	allowFrom: createAllowFromSection({
		helpTitle: t("wizard.synologyChat.allowlistTitle"),
		helpLines: SYNOLOGY_ALLOW_FROM_HELP_LINES,
		message: t("wizard.synologyChat.allowedUserIdsPrompt"),
		placeholder: "123456, 987654",
		invalidWithoutCredentialNote: t("wizard.synologyChat.allowedUserIdsInvalid"),
		parseInputs: splitSetupEntries,
		parseId: parseSynologyUserId,
		apply: async ({ cfg, accountId, allowFrom }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			patch: {
				dmPolicy: "allowlist",
				allowedUserIds: mergeAllowFromEntries(resolveExistingAllowedUserIds(cfg, accountId), allowFrom)
			}
		})
	}),
	completionNote: {
		title: t("wizard.synologyChat.accessControlTitle"),
		lines: [
			`Default outgoing webhook path: ${DEFAULT_WEBHOOK_PATH}`,
			"Set allowed user IDs, or manually switch `channels.synology-chat.dmPolicy` to `\"open\"` with `allowedUserIds: [\"*\"]` for public DMs.",
			"With `dmPolicy=\"allowlist\"`, an empty allowedUserIds list blocks the route from starting.",
			`Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`
		]
	},
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
};
//#endregion
export { resolveAccount as i, synologyChatSetupWizard as n, listAccountIds as r, synologyChatSetupAdapter as t };
