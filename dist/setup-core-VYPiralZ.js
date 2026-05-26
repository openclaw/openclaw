import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { s as hasConfiguredSecretInput } from "./types.secrets-BxqheYvy.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-CwBWagLE.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { n as describeAccountSnapshot } from "./account-helpers-Ba4hZbOH.js";
import { r as createEnvPatchedAccountSetupAdapter } from "./setup-helpers-D1h9Zq-C.js";
import "./secret-input-DlbCRffO.js";
import { J as setSetupChannelEnabled, S as parseMentionOrPrefixedId, T as patchChannelConfigForAccount, f as createStandardChannelSetupStatus, i as createAccountScopedGroupAccessSection, o as createLegacyCompatChannelDmPolicy, r as createAccountScopedAllowFromSection } from "./setup-wizard-helpers-Cm8y4liy.js";
import { t as createAllowlistSetupWizardProxy } from "./setup-wizard-proxy-HeBrCZ-u.js";
import "./setup-runtime-hbbN9wHP.js";
import "./setup-tools-WOmaR-iv.js";
import { a as resolveSlackAccount } from "./accounts-Ba1LnRZV.js";
import { t as inspectSlackAccount } from "./account-inspect-C_aP3mS7.js";
//#region extensions/slack/src/setup-shared.ts
const SLACK_CHANNEL = "slack";
function buildSlackManifest(botName = "OpenClaw") {
	const safeName = botName.trim() || "OpenClaw";
	const manifest = {
		display_information: {
			name: safeName,
			description: `${safeName} connector for OpenClaw`
		},
		features: {
			bot_user: {
				display_name: safeName,
				always_online: true
			},
			app_home: {
				home_tab_enabled: true,
				messages_tab_enabled: true,
				messages_tab_read_only_enabled: false
			},
			slash_commands: [{
				command: "/openclaw",
				description: "Send a message to OpenClaw",
				should_escape: false
			}]
		},
		oauth_config: { scopes: { bot: [
			"app_mentions:read",
			"assistant:write",
			"channels:history",
			"channels:read",
			"chat:write",
			"commands",
			"emoji:read",
			"files:read",
			"files:write",
			"groups:history",
			"groups:read",
			"im:history",
			"im:read",
			"im:write",
			"mpim:history",
			"mpim:read",
			"mpim:write",
			"pins:read",
			"pins:write",
			"reactions:read",
			"reactions:write",
			"usergroups:read",
			"users:read"
		] } },
		settings: {
			socket_mode_enabled: true,
			event_subscriptions: { bot_events: [
				"app_home_opened",
				"app_mention",
				"channel_rename",
				"member_joined_channel",
				"member_left_channel",
				"message.channels",
				"message.groups",
				"message.im",
				"message.mpim",
				"pin_added",
				"pin_removed",
				"reaction_added",
				"reaction_removed"
			] }
		}
	};
	return JSON.stringify(manifest, null, 2);
}
function buildSlackSetupLines() {
	return [
		"1) Slack API -> Create App -> From scratch or From manifest (with the JSON below)",
		"2) Add Socket Mode + enable it to get the app-level token (xapp-...)",
		"3) Install App to workspace to get the xoxb- bot token",
		"4) Enable Event Subscriptions (socket) for message and App Home events",
		"5) App Home -> enable the Home tab and Messages tab for DMs",
		"Manifest JSON follows as plain text for copy/paste.",
		"Tip: set SLACK_BOT_TOKEN + SLACK_APP_TOKEN in your env.",
		`Docs: ${formatDocsLink("/slack", "slack")}`
	];
}
function setSlackChannelAllowlist(cfg, accountId, channelKeys) {
	return patchChannelConfigForAccount({
		cfg,
		channel: SLACK_CHANNEL,
		accountId,
		patch: { channels: Object.fromEntries(channelKeys.map((key) => [key, { enabled: true }])) }
	});
}
function isSlackSetupAccountConfigured(account) {
	const hasConfiguredBotToken = Boolean(account.botToken?.trim()) || hasConfiguredSecretInput(account.config.botToken);
	const hasConfiguredAppToken = Boolean(account.appToken?.trim()) || hasConfiguredSecretInput(account.config.appToken);
	return hasConfiguredBotToken && hasConfiguredAppToken;
}
function describeSlackSetupAccount(account) {
	return describeAccountSnapshot({
		account,
		configured: isSlackSetupAccountConfigured(account),
		extra: {
			botTokenSource: account.botTokenSource,
			appTokenSource: account.appTokenSource
		}
	});
}
//#endregion
//#region extensions/slack/src/setup-core.ts
function enableSlackAccount(cfg, accountId) {
	return patchChannelConfigForAccount({
		cfg,
		channel: SLACK_CHANNEL,
		accountId,
		patch: { enabled: true }
	});
}
function hasSlackInteractiveRepliesConfig(cfg, accountId) {
	const capabilities = resolveSlackAccount({
		cfg,
		accountId
	}).config.capabilities;
	if (Array.isArray(capabilities)) return capabilities.some((entry) => normalizeLowercaseStringOrEmpty(entry) === "interactivereplies");
	if (!capabilities || typeof capabilities !== "object") return false;
	return "interactiveReplies" in capabilities;
}
function setSlackInteractiveReplies(cfg, accountId, interactiveReplies) {
	const capabilities = resolveSlackAccount({
		cfg,
		accountId
	}).config.capabilities;
	return patchChannelConfigForAccount({
		cfg,
		channel: SLACK_CHANNEL,
		accountId,
		patch: { capabilities: Array.isArray(capabilities) ? interactiveReplies ? [...new Set([...capabilities, "interactiveReplies"])] : capabilities.filter((entry) => normalizeLowercaseStringOrEmpty(entry) !== "interactivereplies") : {
			...capabilities && typeof capabilities === "object" ? capabilities : {},
			interactiveReplies
		} }
	});
}
function createSlackTokenCredential(params) {
	return {
		inputKey: params.inputKey,
		providerHint: params.providerHint,
		credentialLabel: params.credentialLabel,
		preferredEnvVar: params.preferredEnvVar,
		envPrompt: `${params.preferredEnvVar} detected. Use env var?`,
		keepPrompt: params.keepPrompt,
		inputPrompt: params.inputPrompt,
		allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
		inspect: ({ cfg, accountId }) => {
			const resolved = resolveSlackAccount({
				cfg,
				accountId
			});
			const configuredValue = params.inputKey === "botToken" ? resolved.config.botToken : resolved.config.appToken;
			const resolvedValue = params.inputKey === "botToken" ? resolved.botToken : resolved.appToken;
			return {
				accountConfigured: Boolean(resolvedValue) || hasConfiguredSecretInput(configuredValue),
				hasConfiguredValue: hasConfiguredSecretInput(configuredValue),
				resolvedValue: normalizeOptionalString(resolvedValue),
				envValue: accountId === "default" ? normalizeOptionalString(process.env[params.preferredEnvVar]) : void 0
			};
		},
		applyUseEnv: ({ cfg, accountId }) => enableSlackAccount(cfg, accountId),
		applySet: ({ cfg, accountId, value }) => patchChannelConfigForAccount({
			cfg,
			channel: SLACK_CHANNEL,
			accountId,
			patch: {
				enabled: true,
				[params.inputKey]: value
			}
		})
	};
}
const slackSetupAdapter = createEnvPatchedAccountSetupAdapter({
	channelKey: SLACK_CHANNEL,
	defaultAccountOnlyEnvError: "Slack env tokens can only be used for the default account.",
	missingCredentialError: "Slack requires --bot-token and --app-token (or --use-env).",
	hasCredentials: (input) => Boolean(input.botToken && input.appToken),
	buildPatch: (input) => ({
		...input.botToken ? { botToken: input.botToken } : {},
		...input.appToken ? { appToken: input.appToken } : {}
	})
});
function createSlackSetupWizardBase(handlers) {
	const slackDmPolicy = createLegacyCompatChannelDmPolicy({
		label: "Slack",
		channel: SLACK_CHANNEL,
		promptAllowFrom: handlers.promptAllowFrom
	});
	return {
		channel: SLACK_CHANNEL,
		status: createStandardChannelSetupStatus({
			channelLabel: "Slack",
			configuredLabel: "configured",
			unconfiguredLabel: "needs tokens",
			configuredHint: "configured",
			unconfiguredHint: "needs tokens",
			configuredScore: 2,
			unconfiguredScore: 1,
			resolveConfigured: ({ cfg, accountId }) => inspectSlackAccount({
				cfg,
				accountId
			}).configured
		}),
		introNote: {
			title: "Slack socket mode tokens",
			lines: buildSlackSetupLines(),
			shouldShow: ({ cfg, accountId }) => !isSlackSetupAccountConfigured(resolveSlackAccount({
				cfg,
				accountId
			}))
		},
		prepare: async ({ cfg, accountId, prompter }) => {
			if (isSlackSetupAccountConfigured(resolveSlackAccount({
				cfg,
				accountId
			}))) return;
			const manifest = buildSlackManifest();
			if (prompter.plain) await prompter.plain(manifest);
			else await prompter.note(manifest, "Slack manifest JSON");
		},
		envShortcut: {
			prompt: "SLACK_BOT_TOKEN + SLACK_APP_TOKEN detected. Use env vars?",
			preferredEnvVar: "SLACK_BOT_TOKEN",
			isAvailable: ({ cfg, accountId }) => accountId === "default" && Boolean(process.env.SLACK_BOT_TOKEN?.trim()) && Boolean(process.env.SLACK_APP_TOKEN?.trim()) && !isSlackSetupAccountConfigured(resolveSlackAccount({
				cfg,
				accountId
			})),
			apply: ({ cfg, accountId }) => enableSlackAccount(cfg, accountId)
		},
		credentials: [createSlackTokenCredential({
			inputKey: "botToken",
			providerHint: "slack-bot",
			credentialLabel: "Slack bot token",
			preferredEnvVar: "SLACK_BOT_TOKEN",
			keepPrompt: "Slack bot token already configured. Keep it?",
			inputPrompt: "Enter Slack bot token (xoxb-...)"
		}), createSlackTokenCredential({
			inputKey: "appToken",
			providerHint: "slack-app",
			credentialLabel: "Slack app token",
			preferredEnvVar: "SLACK_APP_TOKEN",
			keepPrompt: "Slack app token already configured. Keep it?",
			inputPrompt: "Enter Slack app token (xapp-...)"
		})],
		dmPolicy: slackDmPolicy,
		allowFrom: createAccountScopedAllowFromSection({
			channel: SLACK_CHANNEL,
			credentialInputKey: "botToken",
			helpTitle: "Slack allowlist",
			helpLines: [
				"Allowlist Slack DMs by username (we resolve to user ids).",
				"Examples:",
				"- U12345678",
				"- @alice",
				"Multiple entries: comma-separated.",
				`Docs: ${formatDocsLink("/slack", "slack")}`
			],
			message: "Slack allowFrom (usernames or ids)",
			placeholder: "@alice, U12345678",
			invalidWithoutCredentialNote: "Slack token missing; use user ids (or mention form) only.",
			parseId: (value) => parseMentionOrPrefixedId({
				value,
				mentionPattern: /^<@([A-Z0-9]+)>$/i,
				prefixPattern: /^(slack:|user:)/i,
				idPattern: /^[A-Z][A-Z0-9]+$/i,
				normalizeId: (id) => id.toUpperCase()
			}),
			resolveEntries: handlers.resolveAllowFromEntries
		}),
		groupAccess: createAccountScopedGroupAccessSection({
			channel: SLACK_CHANNEL,
			label: "Slack channels",
			placeholder: "#general, #private, C123",
			currentPolicy: ({ cfg, accountId }) => resolveSlackAccount({
				cfg,
				accountId
			}).config.groupPolicy ?? "allowlist",
			currentEntries: ({ cfg, accountId }) => Object.entries(resolveSlackAccount({
				cfg,
				accountId
			}).config.channels ?? {}).filter(([, value]) => value?.enabled !== false).map(([key]) => key),
			updatePrompt: ({ cfg, accountId }) => Boolean(resolveSlackAccount({
				cfg,
				accountId
			}).config.channels),
			resolveAllowlist: handlers.resolveGroupAllowlist,
			fallbackResolved: (entries) => entries,
			applyAllowlist: ({ cfg, accountId, resolved }) => setSlackChannelAllowlist(cfg, accountId, resolved)
		}),
		finalize: async ({ cfg, accountId, options, prompter }) => {
			if (hasSlackInteractiveRepliesConfig(cfg, accountId)) return;
			if (options?.quickstartDefaults) return { cfg: setSlackInteractiveReplies(cfg, accountId, true) };
			return { cfg: setSlackInteractiveReplies(cfg, accountId, await prompter.confirm({
				message: "Enable Slack interactive replies (buttons/selects) for agent responses?",
				initialValue: true
			})) };
		},
		disable: (cfg) => setSetupChannelEnabled(cfg, SLACK_CHANNEL, false)
	};
}
function createSlackSetupWizardProxy(loadWizard) {
	return createAllowlistSetupWizardProxy({
		loadWizard: async () => (await loadWizard()).slackSetupWizard,
		createBase: createSlackSetupWizardBase,
		fallbackResolvedGroupAllowlist: (entries) => entries
	});
}
//#endregion
export { describeSlackSetupAccount as a, SLACK_CHANNEL as i, createSlackSetupWizardProxy as n, isSlackSetupAccountConfigured as o, slackSetupAdapter as r, createSlackSetupWizardBase as t };
