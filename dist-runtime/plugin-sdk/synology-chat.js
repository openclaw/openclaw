import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-CbP51u9x.js";
import "./runtime-DRRlb-lt.js";
import { Ad as isRequestBodyLimitError, Fd as registerPluginHttpRoute, Md as readRequestBodyWithLimit, Nd as requestBodyErrorToText, f as setSetupChannelEnabled, g as splitSetupEntries, r as mergeAllowFromEntries, za as createFixedWindowRateLimiter } from "./setup-wizard-helpers-Bds9SZeS.js";
import "./provider-env-vars-CWXfFyDU.js";
import "./logger-DEV1v8zB.js";
import "./tmp-openclaw-dir-DGafsubg.js";
import "./subsystem-BunQspj4.js";
import "./utils-C9epF7GR.js";
import "./fetch-s6LpGbVn.js";
import "./retry-Bdb5CNwD.js";
import { t as emptyPluginConfigSchema } from "./config-schema-X8cahxVt.js";
import "./paths-BoU0P6Xb.js";
import "./signal-Bycwzc0M.js";
import { r as setAccountEnabledInConfigSection, u as buildChannelConfigSchema } from "./config-helpers-C9J9Kf27.js";
import "./fetch-CokEYQHV.js";
import "./exec-LHBFP7K9.js";
import "./agent-scope-BAdJcjtf.js";
import { u as formatDocsLink } from "./reply-prefix-B-13vT7e.js";
import "./logger-kC9I1OJ3.js";
import "./fetch-guard-COmtEumo.js";
import "./resolve-route-5UJLanKQ.js";
import "./pairing-token-BUkoGEse.js";
import "./query-expansion-DrHj090u.js";
import "./redact-DDISwu8-.js";
import "./channel-plugin-common-cMzLzrLW.js";
import "./secret-file-B_1xic5c.js";
//#region extensions/synology-chat/src/accounts.ts
/** Extract the channel config from the full OpenClaw config object. */
function getChannelConfig$1(cfg) {
	return cfg?.channels?.["synology-chat"];
}
/** Parse allowedUserIds from string or array to string[]. */
function parseAllowedUserIds(raw) {
	if (!raw) {return [];}
	if (Array.isArray(raw)) {return raw.filter(Boolean);}
	return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function parseRateLimitPerMinute(raw) {
	if (raw == null) {return 30;}
	const trimmed = raw.trim();
	if (!/^-?\d+$/.test(trimmed)) {return 30;}
	return Number.parseInt(trimmed, 10);
}
/**
* List all configured account IDs for this channel.
* Returns ["default"] if there's a base config, plus any named accounts.
*/
function listAccountIds(cfg) {
	const channelCfg = getChannelConfig$1(cfg);
	if (!channelCfg) {return [];}
	const ids = /* @__PURE__ */ new Set();
	if (channelCfg.token || process.env.SYNOLOGY_CHAT_TOKEN) {ids.add("default");}
	if (channelCfg.accounts) {for (const id of Object.keys(channelCfg.accounts)) ids.add(id);}
	return Array.from(ids);
}
/**
* Resolve a specific account by ID with full defaults applied.
* Falls back to env vars for the "default" account.
*/
function resolveAccount(cfg, accountId) {
	const channelCfg = getChannelConfig$1(cfg) ?? {};
	const id = accountId || "default";
	const accountOverride = channelCfg.accounts?.[id] ?? {};
	const envToken = process.env.SYNOLOGY_CHAT_TOKEN ?? "";
	const envIncomingUrl = process.env.SYNOLOGY_CHAT_INCOMING_URL ?? "";
	const envNasHost = process.env.SYNOLOGY_NAS_HOST ?? "localhost";
	const envAllowedUserIds = process.env.SYNOLOGY_ALLOWED_USER_IDS ?? "";
	const envRateLimitValue = parseRateLimitPerMinute(process.env.SYNOLOGY_RATE_LIMIT);
	const envBotName = process.env.OPENCLAW_BOT_NAME ?? "OpenClaw";
	return {
		accountId: id,
		enabled: accountOverride.enabled ?? channelCfg.enabled ?? true,
		token: accountOverride.token ?? channelCfg.token ?? envToken,
		incomingUrl: accountOverride.incomingUrl ?? channelCfg.incomingUrl ?? envIncomingUrl,
		nasHost: accountOverride.nasHost ?? channelCfg.nasHost ?? envNasHost,
		webhookPath: accountOverride.webhookPath ?? channelCfg.webhookPath ?? "/webhook/synology",
		dmPolicy: accountOverride.dmPolicy ?? channelCfg.dmPolicy ?? "allowlist",
		allowedUserIds: parseAllowedUserIds(accountOverride.allowedUserIds ?? channelCfg.allowedUserIds ?? envAllowedUserIds),
		rateLimitPerMinute: accountOverride.rateLimitPerMinute ?? channelCfg.rateLimitPerMinute ?? envRateLimitValue,
		botName: accountOverride.botName ?? channelCfg.botName ?? envBotName,
		allowInsecureSsl: accountOverride.allowInsecureSsl ?? channelCfg.allowInsecureSsl ?? false
	};
}
//#endregion
//#region extensions/synology-chat/src/setup-surface.ts
const channel = "synology-chat";
const DEFAULT_WEBHOOK_PATH = "/webhook/synology";
const SYNOLOGY_SETUP_HELP_LINES = [
	"1) Create an incoming webhook in Synology Chat and copy its URL",
	"2) Create an outgoing webhook and copy its secret token",
	`3) Point the outgoing webhook to https://<gateway-host>${DEFAULT_WEBHOOK_PATH}`,
	"4) Keep allowed user IDs handy for DM allowlisting",
	`Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`
];
const SYNOLOGY_ALLOW_FROM_HELP_LINES = [
	"Allowlist Synology Chat DMs by numeric user id.",
	"Examples:",
	"- 123456",
	"- synology-chat:123456",
	"Multiple entries: comma-separated.",
	`Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`
];
function getChannelConfig(cfg) {
	return cfg.channels?.[channel] ?? {};
}
function getRawAccountConfig(cfg, accountId) {
	const channelConfig = getChannelConfig(cfg);
	if (accountId === "default") {return channelConfig;}
	return channelConfig.accounts?.[accountId] ?? {};
}
function patchSynologyChatAccountConfig(params) {
	const channelConfig = getChannelConfig(params.cfg);
	if (params.accountId === "default") {
		const nextChannelConfig = { ...channelConfig };
		for (const field of params.clearFields ?? []) {delete nextChannelConfig[field];}
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
	for (const field of params.clearFields ?? []) {delete nextAccountConfig[field];}
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
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {return "Incoming webhook must use http:// or https://.";}
	} catch {
		return "Incoming webhook must be a valid URL.";
	}
}
function validateWebhookPath(value) {
	const trimmed = value.trim();
	if (!trimmed) {return;}
	return trimmed.startsWith("/") ? void 0 : "Webhook path must start with /.";
}
function parseSynologyUserId(value) {
	const cleaned = value.replace(/^synology-chat:/i, "").trim();
	return /^\d+$/.test(cleaned) ? cleaned : null;
}
function resolveExistingAllowedUserIds(cfg, accountId) {
	const raw = getRawAccountConfig(cfg, accountId).allowedUserIds;
	if (Array.isArray(raw)) {return raw.map((value) => String(value).trim()).filter(Boolean);}
	return String(raw ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}
const synologyChatSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) ?? "default",
	validateInput: ({ accountId, input }) => {
		if (input.useEnv && accountId !== "default") {return "Synology Chat env credentials only support the default account.";}
		if (!input.useEnv && !input.token?.trim()) {return "Synology Chat requires --token or --use-env.";}
		if (!input.url?.trim()) {return "Synology Chat requires --url for the incoming webhook.";}
		const urlError = validateWebhookUrl(input.url.trim());
		if (urlError) {return urlError;}
		if (input.webhookPath?.trim()) {return validateWebhookPath(input.webhookPath.trim()) ?? null;}
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
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs token + incoming webhook",
		configuredHint: "configured",
		unconfiguredHint: "needs token + incoming webhook",
		configuredScore: 1,
		unconfiguredScore: 0,
		resolveConfigured: ({ cfg }) => listAccountIds(cfg).some((accountId) => isSynologyChatConfigured(cfg, accountId)),
		resolveStatusLines: ({ cfg, configured }) => [`Synology Chat: ${configured ? "configured" : "needs token + incoming webhook"}`, `Accounts: ${listAccountIds(cfg).length || 0}`]
	},
	introNote: {
		title: "Synology Chat webhook setup",
		lines: SYNOLOGY_SETUP_HELP_LINES
	},
	credentials: [{
		inputKey: "token",
		providerHint: channel,
		credentialLabel: "outgoing webhook token",
		preferredEnvVar: "SYNOLOGY_CHAT_TOKEN",
		helpTitle: "Synology Chat webhook token",
		helpLines: SYNOLOGY_SETUP_HELP_LINES,
		envPrompt: "SYNOLOGY_CHAT_TOKEN detected. Use env var?",
		keepPrompt: "Synology Chat webhook token already configured. Keep it?",
		inputPrompt: "Enter Synology Chat outgoing webhook token",
		allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
		inspect: ({ cfg, accountId }) => {
			const account = resolveAccount(cfg, accountId);
			const raw = getRawAccountConfig(cfg, accountId);
			return {
				accountConfigured: isSynologyChatConfigured(cfg, accountId),
				hasConfiguredValue: Boolean(raw.token?.trim()),
				resolvedValue: account.token.trim() || void 0,
				envValue: accountId === "default" ? process.env.SYNOLOGY_CHAT_TOKEN?.trim() || void 0 : void 0
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
		message: "Incoming webhook URL",
		placeholder: "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming...",
		helpTitle: "Synology Chat incoming webhook",
		helpLines: ["Use the incoming webhook URL from Synology Chat integrations.", "This is the URL OpenClaw uses to send replies back to Chat."],
		currentValue: ({ cfg, accountId }) => getRawAccountConfig(cfg, accountId).incomingUrl?.trim(),
		keepPrompt: (value) => `Incoming webhook URL set (${value}). Keep it?`,
		validate: ({ value }) => validateWebhookUrl(value),
		applySet: async ({ cfg, accountId, value }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			patch: { incomingUrl: value.trim() }
		})
	}, {
		inputKey: "webhookPath",
		message: "Outgoing webhook path (optional)",
		placeholder: DEFAULT_WEBHOOK_PATH,
		required: false,
		applyEmptyValue: true,
		helpTitle: "Synology Chat outgoing webhook path",
		helpLines: [`Default path: ${DEFAULT_WEBHOOK_PATH}`, "Change this only if you need multiple Synology Chat webhook routes."],
		currentValue: ({ cfg, accountId }) => getRawAccountConfig(cfg, accountId).webhookPath?.trim(),
		keepPrompt: (value) => `Outgoing webhook path set (${value}). Keep it?`,
		validate: ({ value }) => validateWebhookPath(value),
		applySet: async ({ cfg, accountId, value }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: value.trim() ? void 0 : ["webhookPath"],
			patch: value.trim() ? { webhookPath: value.trim() } : {}
		})
	}],
	allowFrom: {
		helpTitle: "Synology Chat allowlist",
		helpLines: SYNOLOGY_ALLOW_FROM_HELP_LINES,
		message: "Allowed Synology Chat user ids",
		placeholder: "123456, 987654",
		invalidWithoutCredentialNote: "Synology Chat user ids must be numeric.",
		parseInputs: splitSetupEntries,
		parseId: parseSynologyUserId,
		resolveEntries: async ({ entries }) => entries.map((entry) => {
			const id = parseSynologyUserId(entry);
			return {
				input: entry,
				resolved: Boolean(id),
				id
			};
		}),
		apply: async ({ cfg, accountId, allowFrom }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			patch: {
				dmPolicy: "allowlist",
				allowedUserIds: mergeAllowFromEntries(resolveExistingAllowedUserIds(cfg, accountId), allowFrom)
			}
		})
	},
	completionNote: {
		title: "Synology Chat access control",
		lines: [
			`Default outgoing webhook path: ${DEFAULT_WEBHOOK_PATH}`,
			"Set allowed user IDs, or manually switch `channels.synology-chat.dmPolicy` to `\"open\"` for public DMs.",
			"With `dmPolicy=\"allowlist\"`, an empty allowedUserIds list blocks the route from starting.",
			`Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`
		]
	},
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
};
//#endregion
export { DEFAULT_ACCOUNT_ID, buildChannelConfigSchema, createFixedWindowRateLimiter, emptyPluginConfigSchema, isRequestBodyLimitError, readRequestBodyWithLimit, registerPluginHttpRoute, requestBodyErrorToText, setAccountEnabledInConfigSection, synologyChatSetupAdapter, synologyChatSetupWizard };
