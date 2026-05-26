import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { t as getChatChannelMeta } from "./chat-meta-2H4wOcrq.js";
import { r as buildChannelConfigSchema } from "./config-schema-ChfiQrSg.js";
import { n as resolveNormalizedAccountEntry } from "./account-lookup-CQEoGO1F.js";
import { S as resolveChannelStreamingBlockEnabled, k as resolveChannelStreamingPreviewToolProgress } from "./channel-streaming-BKIuGSWW.js";
import { l as createScopedDmSecurityResolver, s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "./channel-config-helpers-xZ4-bv2H.js";
import { r as makeProxyFetch } from "./proxy-fetch-B02LTFkt.js";
import { a as hasTelegramBotEndpointApiRoot, n as resolveTelegramFetch, o as normalizeTelegramApiRoot, t as resolveTelegramApiBase } from "./fetch-Dy1LisTE.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./account-core-DdyIQODw.js";
import { n as applySetupAccountConfigPatch, r as createEnvPatchedAccountSetupAdapter } from "./setup-helpers-BC9z9VvG.js";
import { t as createChannelPluginBase } from "./channel-core-CV-k5W6W.js";
import "./routing-79DRZvfm.js";
import { t as formatAllowFromLowercase } from "./allow-from-CvE3rvhy.js";
import { y as createAllowlistProviderRouteAllowlistWarningCollector } from "./channel-policy-pv8ZpZxj.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { J as setSetupChannelEnabled, N as promptResolvedAllowFrom, Q as splitSetupEntries, T as patchChannelConfigForAccount, a as createAllowFromSection, f as createStandardChannelSetupStatus, t as addWildcardAllowFrom } from "./setup-wizard-helpers-Dbpzm32P.js";
import "./setup-DPvocg6M.js";
import "./setup-runtime-BRbeJqWD.js";
import "./setup-tools-DuiMNzp5.js";
import "./channel-plugin-common-fWZhnLoH.js";
import { c as TelegramConfigSchema } from "./bundled-channel-config-schema-CA36mrPs.js";
import { t as mergeTelegramAccountConfig } from "./account-config-Bxlwl4Ps.js";
import { a as resolveDefaultTelegramAccountId, o as resolveTelegramAccount, r as listTelegramAccountIds } from "./accounts-CYn64t2S.js";
import { t as inspectTelegramAccount } from "./account-inspect-BaUmkBp5.js";
import { r as normalizeTelegramAllowFromEntry, t as isNumericTelegramSenderUserId } from "./allow-from-Byf7JKVc.js";
import { t as resolveTelegramPreviewStreamMode } from "./preview-streaming-CpiesNih.js";
import { t as collectTelegramSecurityAuditFindings } from "./security-audit-Dr3maS5B.js";
import { a as buildTelegramModelsListChannelData, c as buildTelegramModelsProviderChannelData, i as buildTelegramModelsAddProviderChannelData, n as buildTelegramCommandsListChannelData, r as buildTelegramModelBrowseChannelData, s as buildTelegramModelsMenuChannelData } from "./command-ui-Cfv5GGb1.js";
import "./config-api-BhFXivs7.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "./doctor-contract-Ceb9U89m.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "./secret-contract-B2qThY--.js";
import { n as singleAccountKeysToMove, t as namedAccountPromotionKeys } from "./setup-contract-BGJIzcry.js";
import { t as detectTelegramLegacyStateMigrations } from "./state-migrations-CDhZFfzx.js";
//#region extensions/telegram/src/api-fetch.ts
function resolveTelegramChatLookupFetch(params) {
	const proxyUrl = params?.proxyUrl?.trim();
	return resolveTelegramFetch(proxyUrl ? makeProxyFetch(proxyUrl) : void 0, { network: params?.network });
}
async function lookupTelegramChatId(params) {
	return fetchTelegramChatId({
		token: params.token,
		chatId: params.chatId,
		signal: params.signal,
		apiRoot: params.apiRoot,
		fetchImpl: resolveTelegramChatLookupFetch({
			proxyUrl: params.proxyUrl,
			network: params.network
		})
	});
}
async function fetchTelegramChatId(params) {
	const url = `${resolveTelegramApiBase(params.apiRoot)}/bot${params.token}/getChat?chat_id=${encodeURIComponent(params.chatId)}`;
	const fetchImpl = params.fetchImpl ?? fetch;
	try {
		const res = await fetchImpl(url, params.signal ? { signal: params.signal } : void 0);
		if (!res.ok) return null;
		const data = await res.json().catch(() => null);
		const id = data?.ok ? data?.result?.id : void 0;
		if (typeof id === "number" || typeof id === "string") return String(id);
		return null;
	} catch {
		return null;
	}
}
const telegramSecurityAdapter = {
	resolveDmPolicy: createScopedDmSecurityResolver({
		channelKey: "telegram",
		resolvePolicy: (account) => account.config.dmPolicy,
		resolveAllowFrom: (account) => account.config.allowFrom,
		policyPathSuffix: "dmPolicy",
		normalizeEntry: (raw) => raw.replace(/^(telegram|tg):/i, "")
	}),
	collectWarnings: createAllowlistProviderRouteAllowlistWarningCollector({
		providerConfigPresent: (cfg) => cfg.channels?.telegram !== void 0,
		resolveGroupPolicy: (account) => account.config.groupPolicy,
		resolveRouteAllowlistConfigured: (account) => Boolean(account.config.groups) && Object.keys(account.config.groups ?? {}).length > 0,
		restrictSenders: {
			surface: "Telegram groups",
			openScope: "any member in allowed groups",
			groupPolicyPath: "channels.telegram.groupPolicy",
			groupAllowFromPath: "channels.telegram.groupAllowFrom"
		},
		noRouteAllowlist: {
			surface: "Telegram groups",
			routeAllowlistPath: "channels.telegram.groups",
			routeScope: "group",
			groupPolicyPath: "channels.telegram.groupPolicy",
			groupAllowFromPath: "channels.telegram.groupAllowFrom"
		}
	}),
	collectAuditFindings: collectTelegramSecurityAuditFindings
};
//#endregion
//#region extensions/telegram/src/setup-core.ts
const t$1 = createSetupTranslator();
const channel$2 = "telegram";
function getTelegramTokenHelpLines() {
	return [
		t$1("wizard.telegram.tokenHelpOpenBotFather"),
		t$1("wizard.telegram.tokenHelpNewBot"),
		t$1("wizard.telegram.tokenHelpCopyToken"),
		t$1("wizard.telegram.tokenEnvTip"),
		t$1("wizard.channels.docs", { link: formatDocsLink("/telegram") }),
		t$1("wizard.telegram.website", { url: "https://openclaw.ai" })
	];
}
function getTelegramUserIdHelpLines() {
	return [
		t$1("wizard.telegram.userIdHelpLogs", { command: formatCliCommand("openclaw logs --follow") }),
		t$1("wizard.telegram.userIdHelpGetUpdates"),
		t$1("wizard.telegram.userIdHelpThirdParty"),
		t$1("wizard.channels.docs", { link: formatDocsLink("/telegram") }),
		t$1("wizard.telegram.website", { url: "https://openclaw.ai" })
	];
}
getTelegramTokenHelpLines();
getTelegramUserIdHelpLines();
function normalizeTelegramAllowFromInput(raw) {
	return raw.trim().replace(/^(telegram|tg):/i, "").trim();
}
function parseTelegramAllowFromId(raw) {
	const stripped = normalizeTelegramAllowFromInput(raw);
	return isNumericTelegramSenderUserId(stripped) ? stripped : null;
}
async function promptTelegramAllowFromForAccount(params) {
	const accountId = params.accountId ?? resolveDefaultTelegramAccountId(params.cfg);
	const resolved = resolveTelegramAccount({
		cfg: params.cfg,
		accountId
	});
	await params.prompter.note(getTelegramUserIdHelpLines().join("\n"), t$1("wizard.telegram.userIdTitle"));
	const unique = await promptResolvedAllowFrom({
		prompter: params.prompter,
		existing: resolved.config.allowFrom ?? [],
		message: t$1("wizard.telegram.allowFromPrompt"),
		placeholder: "123456789",
		label: t$1("wizard.telegram.allowlistTitle"),
		parseInputs: splitSetupEntries,
		parseId: parseTelegramAllowFromId,
		invalidWithoutTokenNote: t$1("wizard.telegram.allowFromInvalid"),
		resolveEntries: async ({ entries }) => entries.map((entry) => {
			const id = parseTelegramAllowFromId(entry);
			return {
				input: entry,
				resolved: Boolean(id),
				id
			};
		})
	});
	return patchChannelConfigForAccount({
		cfg: params.cfg,
		channel: channel$2,
		accountId,
		patch: {
			dmPolicy: "allowlist",
			allowFrom: unique
		}
	});
}
const telegramSetupAdapter = createEnvPatchedAccountSetupAdapter({
	channelKey: channel$2,
	defaultAccountOnlyEnvError: "TELEGRAM_BOT_TOKEN can only be used for the default account.",
	missingCredentialError: "Telegram requires token or --token-file (or --use-env).",
	hasCredentials: (input) => Boolean(input.token || input.tokenFile),
	buildPatch: (input) => input.tokenFile ? { tokenFile: input.tokenFile } : input.token ? { botToken: input.token } : {}
});
//#endregion
//#region extensions/telegram/src/setup-surface.helpers.ts
const channel$1 = "telegram";
function ensureTelegramDefaultGroupMentionGate(cfg, accountId) {
	const resolved = resolveTelegramAccount({
		cfg,
		accountId
	});
	const wildcardGroup = resolved.config.groups?.["*"];
	if (wildcardGroup?.requireMention !== void 0) return cfg;
	return patchChannelConfigForAccount({
		cfg,
		channel: channel$1,
		accountId,
		patch: { groups: {
			...resolved.config.groups,
			"*": {
				...wildcardGroup,
				requireMention: true
			}
		} }
	});
}
function shouldShowTelegramDmAccessWarning(cfg, accountId) {
	const merged = mergeTelegramAccountConfig(cfg, accountId);
	const policy = merged.dmPolicy ?? "pairing";
	const hasAllowFrom = Array.isArray(merged.allowFrom) && merged.allowFrom.some((entry) => normalizeOptionalString(String(entry)));
	return policy === "pairing" && !hasAllowFrom;
}
function buildTelegramDmAccessWarningLines(accountId) {
	const configBase = accountId === "default" ? "channels.telegram" : `channels.telegram.accounts.${accountId}`;
	return [
		"Your bot is using DM policy: pairing.",
		"Any Telegram user who discovers the bot can send pairing requests.",
		"For private use, configure an allowlist with your Telegram user id:",
		"  " + formatCliCommand(`openclaw config set ${configBase}.dmPolicy "allowlist"`),
		"  " + formatCliCommand(`openclaw config set ${configBase}.allowFrom '["YOUR_USER_ID"]'`),
		`Docs: ${formatDocsLink("/channels/pairing", "channels/pairing")}`
	];
}
const telegramSetupDmPolicy = {
	label: "Telegram",
	channel: channel$1,
	policyKey: "channels.telegram.dmPolicy",
	allowFromKey: "channels.telegram.allowFrom",
	resolveConfigKeys: (cfg, accountId) => (accountId ?? resolveDefaultTelegramAccountId(cfg)) !== "default" ? {
		policyKey: `channels.telegram.accounts.${accountId ?? resolveDefaultTelegramAccountId(cfg)}.dmPolicy`,
		allowFromKey: `channels.telegram.accounts.${accountId ?? resolveDefaultTelegramAccountId(cfg)}.allowFrom`
	} : {
		policyKey: "channels.telegram.dmPolicy",
		allowFromKey: "channels.telegram.allowFrom"
	},
	getCurrent: (cfg, accountId) => mergeTelegramAccountConfig(cfg, accountId ?? resolveDefaultTelegramAccountId(cfg)).dmPolicy ?? "pairing",
	setPolicy: (cfg, policy, accountId) => {
		const resolvedAccountId = accountId ?? resolveDefaultTelegramAccountId(cfg);
		const merged = mergeTelegramAccountConfig(cfg, resolvedAccountId);
		const patch = {
			dmPolicy: policy,
			...policy === "open" ? { allowFrom: addWildcardAllowFrom(merged.allowFrom) } : {}
		};
		return accountId == null && resolvedAccountId !== "default" ? applySetupAccountConfigPatch({
			cfg,
			channelKey: channel$1,
			accountId: resolvedAccountId,
			patch
		}) : patchChannelConfigForAccount({
			cfg,
			channel: channel$1,
			accountId: resolvedAccountId,
			patch
		});
	},
	promptAllowFrom: promptTelegramAllowFromForAccount
};
//#endregion
//#region extensions/telegram/src/setup-surface.ts
const t = createSetupTranslator();
const channel = "telegram";
const telegramSetupWizard = {
	channel,
	status: createStandardChannelSetupStatus({
		channelLabel: "Telegram",
		configuredLabel: t("wizard.channels.statusConfigured"),
		unconfiguredLabel: t("wizard.channels.statusNeedsToken"),
		configuredHint: t("wizard.channels.statusRecommendedConfigured"),
		unconfiguredHint: t("wizard.channels.statusRecommendedNewcomerFriendly"),
		configuredScore: 1,
		unconfiguredScore: 10,
		resolveConfigured: ({ cfg, accountId }) => (accountId ? [accountId] : listTelegramAccountIds(cfg)).some((resolvedAccountId) => {
			return inspectTelegramAccount({
				cfg,
				accountId: resolvedAccountId
			}).configured;
		})
	}),
	prepare: async ({ cfg, accountId, credentialValues }) => ({
		cfg: ensureTelegramDefaultGroupMentionGate(cfg, accountId),
		credentialValues
	}),
	credentials: [{
		inputKey: "token",
		providerHint: channel,
		credentialLabel: t("wizard.telegram.botToken"),
		preferredEnvVar: "TELEGRAM_BOT_TOKEN",
		helpTitle: t("wizard.telegram.botToken"),
		helpLines: getTelegramTokenHelpLines(),
		envPrompt: t("wizard.telegram.tokenEnvPrompt"),
		keepPrompt: t("wizard.telegram.tokenKeepPrompt"),
		inputPrompt: t("wizard.telegram.tokenInputPrompt"),
		allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
		inspect: ({ cfg, accountId }) => {
			const resolved = resolveTelegramAccount({
				cfg,
				accountId
			});
			const hasConfiguredValue = hasConfiguredSecretInput(resolved.config.botToken) || Boolean(resolved.config.tokenFile?.trim());
			return {
				accountConfigured: Boolean(resolved.token) || hasConfiguredValue,
				hasConfiguredValue,
				resolvedValue: normalizeOptionalString(resolved.token),
				envValue: accountId === "default" ? normalizeOptionalString(process.env.TELEGRAM_BOT_TOKEN) : void 0
			};
		}
	}],
	allowFrom: createAllowFromSection({
		helpTitle: t("wizard.telegram.userIdTitle"),
		helpLines: getTelegramUserIdHelpLines(),
		message: t("wizard.telegram.allowFromPrompt"),
		placeholder: "123456789",
		invalidWithoutCredentialNote: t("wizard.telegram.allowFromInvalid"),
		parseInputs: splitSetupEntries,
		parseId: parseTelegramAllowFromId,
		resolveEntries: async ({ entries }) => entries.map((entry) => {
			const id = parseTelegramAllowFromId(entry);
			return {
				input: entry,
				resolved: Boolean(id),
				id
			};
		}),
		apply: async ({ cfg, accountId, allowFrom }) => patchChannelConfigForAccount({
			cfg,
			channel,
			accountId,
			patch: {
				dmPolicy: "allowlist",
				allowFrom
			}
		})
	}),
	finalize: async ({ cfg, accountId, prompter }) => {
		if (!shouldShowTelegramDmAccessWarning(cfg, accountId)) return;
		await prompter.note(buildTelegramDmAccessWarningLines(accountId).join("\n"), "Telegram DM access warning");
	},
	dmPolicy: telegramSetupDmPolicy,
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
};
//#endregion
//#region extensions/telegram/src/config-schema.ts
const TelegramChannelConfigSchema = buildChannelConfigSchema(TelegramConfigSchema, { uiHints: {
	"": {
		label: "Telegram",
		help: "Telegram channel provider configuration including auth tokens, retry behavior, and message rendering controls. Use this section to tune bot behavior for Telegram-specific API semantics."
	},
	customCommands: {
		label: "Telegram Custom Commands",
		help: "Additional Telegram bot menu commands (merged with native; conflicts ignored)."
	},
	botToken: {
		label: "Telegram Bot Token",
		help: "Telegram bot token used to authenticate Bot API requests for this account/provider config. Use secret/env substitution and rotate tokens if exposure is suspected."
	},
	dmPolicy: {
		label: "Telegram DM Policy",
		help: "Direct message access control (\"pairing\" recommended). \"open\" requires channels.telegram.allowFrom=[\"*\"]."
	},
	"dm.threadReplies": {
		label: "Telegram DM Thread Replies",
		help: "Controls whether Telegram DMs with message_thread_id use flat sessions (\"off\", default) or thread-scoped sessions (\"inbound\" or \"always\"). Thread IDs are still preserved for replies when sessions stay flat."
	},
	"direct.*.threadReplies": {
		label: "Telegram Per-DM Thread Replies",
		help: "Per-DM override for message_thread_id session threading. Use \"inbound\" only when a specific direct chat intentionally uses Telegram DM topics as separate sessions."
	},
	configWrites: {
		label: "Telegram Config Writes",
		help: "Allow Telegram to write config in response to channel events/commands (default: true)."
	},
	"commands.native": {
		label: "Telegram Native Commands",
		help: "Override native commands for Telegram (bool or \"auto\")."
	},
	"commands.nativeSkills": {
		label: "Telegram Native Skill Commands",
		help: "Override native skill commands for Telegram (bool or \"auto\")."
	},
	streaming: {
		label: "Telegram Streaming Mode",
		help: "Unified Telegram stream preview mode: \"off\" | \"partial\" | \"block\" | \"progress\" (default: \"partial\"). \"progress\" keeps a single editable progress draft until final delivery. Legacy boolean/streamMode keys are detected; run doctor --fix to migrate."
	},
	"streaming.mode": {
		label: "Telegram Streaming Mode",
		help: "Canonical Telegram preview mode: \"off\" | \"partial\" | \"block\" | \"progress\" (default: \"partial\")."
	},
	"streaming.chunkMode": {
		label: "Telegram Chunk Mode",
		help: "Chunking mode for outbound Telegram text delivery: \"length\" (default) or \"newline\"."
	},
	"streaming.block.enabled": {
		label: "Telegram Block Streaming Enabled",
		help: "Enable chunked block-style Telegram preview delivery when channels.telegram.streaming.mode=\"block\"."
	},
	"streaming.block.coalesce": {
		label: "Telegram Block Streaming Coalesce",
		help: "Merge streamed Telegram block replies before sending final delivery."
	},
	"streaming.preview.chunk.minChars": {
		label: "Telegram Draft Chunk Min Chars",
		help: "Minimum chars before emitting a Telegram block preview chunk when channels.telegram.streaming.mode=\"block\"."
	},
	"streaming.preview.chunk.maxChars": {
		label: "Telegram Draft Chunk Max Chars",
		help: "Target max size for a Telegram block preview chunk when channels.telegram.streaming.mode=\"block\"."
	},
	"streaming.preview.chunk.breakPreference": {
		label: "Telegram Draft Chunk Break Preference",
		help: "Preferred breakpoints for Telegram draft chunks (paragraph | newline | sentence)."
	},
	"streaming.preview.toolProgress": {
		label: "Telegram Draft Tool Progress",
		help: "Show tool/progress activity in the live draft preview message (default: true when preview streaming is active). Set false to keep tool updates out of the edited Telegram preview."
	},
	"streaming.preview.commandText": {
		label: "Telegram Draft Command Text",
		help: "Command/exec detail in preview tool-progress lines: \"raw\" preserves released behavior; \"status\" shows only the tool label."
	},
	"streaming.progress.label": {
		label: "Telegram Progress Label",
		help: "Initial progress draft title. Use \"auto\" for built-in single-word labels, a custom string, or false to hide the title."
	},
	"streaming.progress.labels": {
		label: "Telegram Progress Label Pool",
		help: "Candidate labels for streaming.progress.label=\"auto\". Leave unset to use OpenClaw built-in progress labels."
	},
	"streaming.progress.maxLines": {
		label: "Telegram Progress Max Lines",
		help: "Maximum number of compact progress lines to keep below the draft label (default: 8)."
	},
	"streaming.progress.maxLineChars": {
		label: "Telegram Progress Max Line Chars",
		help: "Maximum characters per compact progress line before truncation (default: 120). Prose cuts at word boundaries; commands and paths keep useful suffixes."
	},
	"streaming.progress.toolProgress": {
		label: "Telegram Progress Tool Lines",
		help: "Show compact tool/progress lines in progress draft mode (default: true). Set false to keep only the label until final delivery."
	},
	"streaming.progress.commandText": {
		label: "Telegram Progress Command Text",
		help: "Command/exec detail in progress draft lines: \"raw\" preserves released behavior; \"status\" shows only the tool label."
	},
	"retry.attempts": {
		label: "Telegram Retry Attempts",
		help: "Max retry attempts for outbound Telegram API calls (default: 3)."
	},
	"retry.minDelayMs": {
		label: "Telegram Retry Min Delay (ms)",
		help: "Minimum retry delay in ms for Telegram outbound calls."
	},
	"retry.maxDelayMs": {
		label: "Telegram Retry Max Delay (ms)",
		help: "Maximum retry delay cap in ms for Telegram outbound calls."
	},
	"retry.jitter": {
		label: "Telegram Retry Jitter",
		help: "Jitter factor (0-1) applied to Telegram retry delays."
	},
	"network.autoSelectFamily": {
		label: "Telegram autoSelectFamily",
		help: "Override Node autoSelectFamily for Telegram (true=enable, false=disable)."
	},
	"network.dangerouslyAllowPrivateNetwork": {
		label: "Telegram Dangerously Allow Private Network",
		help: "Dangerous opt-in for trusted fake-IP or transparent-proxy environments where Telegram media downloads resolve api.telegram.org to private/internal/special-use addresses."
	},
	timeoutSeconds: {
		label: "Telegram API Timeout (seconds)",
		help: "Max seconds before Telegram API requests are aborted (default: 500 per grammY)."
	},
	mediaGroupFlushMs: {
		label: "Telegram Media Group Flush (ms)",
		help: "Milliseconds to buffer Telegram albums/media groups before dispatching them as one inbound message. Default: 500."
	},
	pollingStallThresholdMs: {
		label: "Telegram Polling Stall Threshold (ms)",
		help: "Milliseconds without completed Telegram getUpdates liveness before the polling watchdog restarts the polling runner. Default: 120000."
	},
	silentErrorReplies: {
		label: "Telegram Silent Error Replies",
		help: "When true, Telegram bot replies marked as errors are sent silently (no notification sound). Default: false."
	},
	apiRoot: {
		label: "Telegram API Root URL",
		help: "Custom Telegram Bot API root URL. Use the API root only (for example https://api.telegram.org), not a full /bot<TOKEN> endpoint. Use for self-hosted Bot API servers (https://github.com/tdlib/telegram-bot-api) or reverse proxies in regions where api.telegram.org is blocked."
	},
	trustedLocalFileRoots: {
		label: "Telegram Trusted Local File Roots",
		help: "Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. Only absolute paths inside these roots are read directly; all other absolute paths are rejected."
	},
	autoTopicLabel: {
		label: "Telegram Auto Topic Label",
		help: "Auto-rename DM forum topics on first message using LLM. Default: true. Set to false to disable, or use object form { enabled: true, prompt: '...' } for custom prompt."
	},
	"autoTopicLabel.enabled": {
		label: "Telegram Auto Topic Label Enabled",
		help: "Whether auto topic labeling is enabled. Default: true."
	},
	"autoTopicLabel.prompt": {
		label: "Telegram Auto Topic Label Prompt",
		help: "Custom prompt for LLM-based topic naming. The user message is appended after the prompt."
	},
	"capabilities.inlineButtons": {
		label: "Telegram Inline Buttons",
		help: "Enable Telegram inline button components for supported command and interaction surfaces. Disable if your deployment needs plain-text-only compatibility behavior."
	},
	execApprovals: {
		label: "Telegram Exec Approvals",
		help: "Telegram-native exec approval routing and approver authorization. When unset, OpenClaw auto-enables DM-first native approvals if approvers can be resolved for the selected bot account."
	},
	"execApprovals.enabled": {
		label: "Telegram Exec Approvals Enabled",
		help: "Controls Telegram native exec approvals for this account: unset or \"auto\" enables DM-first native approvals when approvers can be resolved, true forces native approvals on, and false disables them."
	},
	"execApprovals.approvers": {
		label: "Telegram Exec Approval Approvers",
		help: "Telegram user IDs allowed to approve exec requests for this bot account. Use numeric Telegram user IDs. If you leave this unset, OpenClaw falls back to numeric owner IDs inferred from commands.ownerAllowFrom when possible."
	},
	"execApprovals.agentFilter": {
		label: "Telegram Exec Approval Agent Filter",
		help: "Optional allowlist of agent IDs eligible for Telegram exec approvals, for example `[\"main\", \"ops-agent\"]`. Use this to keep approval prompts scoped to the agents you actually operate from Telegram."
	},
	"execApprovals.sessionFilter": {
		label: "Telegram Exec Approval Session Filter",
		help: "Optional session-key filters matched as substring or regex-style patterns before Telegram approval routing is used. Use narrow patterns so Telegram approvals only appear for intended sessions."
	},
	"execApprovals.target": {
		label: "Telegram Exec Approval Target",
		help: "Controls where Telegram approval prompts are sent: \"dm\" sends to approver DMs (default), \"channel\" sends to the originating Telegram chat/topic, and \"both\" sends to both. Channel delivery exposes the command text to the chat, so only use it in trusted groups/topics."
	},
	"threadBindings.enabled": {
		label: "Telegram Thread Binding Enabled",
		help: "Enable Telegram conversation binding features (/focus, /unfocus, /agents, and /session idle|max-age). Overrides session.threadBindings.enabled when set."
	},
	"threadBindings.idleHours": {
		label: "Telegram Thread Binding Idle Timeout (hours)",
		help: "Inactivity window in hours for Telegram bound sessions. Set 0 to disable idle auto-unfocus (default: 24). Overrides session.threadBindings.idleHours when set."
	},
	"threadBindings.maxAgeHours": {
		label: "Telegram Thread Binding Max Age (hours)",
		help: "Optional hard max age in hours for Telegram bound sessions. Set 0 to disable hard cap (default: 0). Overrides session.threadBindings.maxAgeHours when set."
	},
	"threadBindings.spawnSessions": {
		label: "Telegram Thread-Bound Session Spawn",
		help: "Allow sessions_spawn(thread=true) and ACP thread spawns to auto-bind Telegram current conversations when supported."
	},
	"threadBindings.defaultSpawnContext": {
		label: "Telegram Thread Spawn Context",
		help: "Default native subagent context for thread-bound spawns. \"fork\" starts from the requester transcript; \"isolated\" starts clean. Default: \"fork\"."
	}
} });
//#endregion
//#region extensions/telegram/src/doctor.ts
function asObjectRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function sanitizeForLog(value) {
	return value.replace(/\p{Cc}+/gu, " ").trim();
}
function hasAllowFromEntries(values) {
	return Array.isArray(values) && values.some((entry) => normalizeOptionalString(String(entry)));
}
function collectTelegramAccountScopes(cfg) {
	const scopes = [];
	const telegram = asObjectRecord(cfg.channels?.telegram);
	if (!telegram) return scopes;
	scopes.push({
		prefix: "channels.telegram",
		pathSegments: ["channels", "telegram"],
		account: telegram
	});
	const accounts = asObjectRecord(telegram.accounts);
	if (!accounts) return scopes;
	for (const key of Object.keys(accounts)) {
		const account = asObjectRecord(accounts[key]);
		if (account) scopes.push({
			prefix: `channels.telegram.accounts.${key}`,
			pathSegments: [
				"channels",
				"telegram",
				"accounts",
				key
			],
			account
		});
	}
	return scopes;
}
function collectTelegramAllowFromLists(prefix, account) {
	const refs = [{
		pathLabel: `${prefix}.allowFrom`,
		holder: account,
		key: "allowFrom"
	}, {
		pathLabel: `${prefix}.groupAllowFrom`,
		holder: account,
		key: "groupAllowFrom"
	}];
	const groups = asObjectRecord(account.groups);
	if (!groups) return refs;
	for (const groupId of Object.keys(groups)) {
		const group = asObjectRecord(groups[groupId]);
		if (!group) continue;
		refs.push({
			pathLabel: `${prefix}.groups.${groupId}.allowFrom`,
			holder: group,
			key: "allowFrom"
		});
		const topics = asObjectRecord(group.topics);
		if (!topics) continue;
		for (const topicId of Object.keys(topics)) {
			const topic = asObjectRecord(topics[topicId]);
			if (!topic) continue;
			refs.push({
				pathLabel: `${prefix}.groups.${groupId}.topics.${topicId}.allowFrom`,
				holder: topic,
				key: "allowFrom"
			});
		}
	}
	return refs;
}
function describeConfigValueType(value) {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}
function scanTelegramMalformedGroupsConfig(cfg) {
	const hits = [];
	for (const scope of collectTelegramAccountScopes(cfg)) {
		if (!Object.prototype.hasOwnProperty.call(scope.account, "groups")) continue;
		const groups = scope.account.groups;
		if (asObjectRecord(groups)) continue;
		hits.push({
			path: `${scope.prefix}.groups`,
			actualType: describeConfigValueType(groups)
		});
	}
	return hits;
}
function collectTelegramMalformedGroupsWarnings(params) {
	if (params.hits.length === 0) return [];
	const sample = params.hits[0] ?? {
		path: "channels.telegram.groups",
		actualType: "unknown"
	};
	return [`- ${sanitizeForLog(sample.path)} has invalid Telegram groups shape (${sanitizeForLog(sample.actualType)}); expected an object map keyed by Telegram group/chat id, not an array, string, or null.`, `- Example shape: channels.telegram.groups."-1001234567890".topics."99" = { agentId: "support" }. Use topics for forum-topic routing, then rerun ${params.doctorFixCommand} for any remaining Telegram config cleanup.`];
}
function scanTelegramInvalidAllowFromEntries(cfg) {
	const hits = [];
	const scanList = (pathLabel, list) => {
		if (!Array.isArray(list)) return;
		for (const entry of list) {
			const normalized = normalizeTelegramAllowFromEntry(entry);
			if (!normalized || normalized === "*" || isNumericTelegramSenderUserId(normalized)) continue;
			hits.push({
				path: pathLabel,
				entry: normalizeOptionalString(String(entry)) ?? ""
			});
		}
	};
	for (const scope of collectTelegramAccountScopes(cfg)) for (const ref of collectTelegramAllowFromLists(scope.prefix, scope.account)) scanList(ref.pathLabel, ref.holder[ref.key]);
	return hits;
}
function collectTelegramInvalidAllowFromWarnings(params) {
	if (params.hits.length === 0) return [];
	const sampleEntry = sanitizeForLog(params.hits[0]?.entry ?? "@");
	return [`- Telegram allowFrom contains ${params.hits.length} invalid sender entries (e.g. ${sampleEntry}); Telegram authorization requires positive numeric sender user IDs.`, `- Run "${params.doctorFixCommand}" to auto-resolve @username entries to numeric IDs (requires a Telegram bot token). Move negative chat IDs under channels.telegram.groups instead of allowFrom.`];
}
function scanTelegramBotEndpointApiRoots(cfg) {
	const hits = [];
	for (const scope of collectTelegramAccountScopes(cfg)) {
		const value = scope.account.apiRoot;
		if (typeof value !== "string" || !hasTelegramBotEndpointApiRoot(value)) continue;
		hits.push({
			path: `${scope.prefix}.apiRoot`,
			pathSegments: [...scope.pathSegments, "apiRoot"],
			value,
			normalized: normalizeTelegramApiRoot(value)
		});
	}
	return hits;
}
function collectTelegramApiRootWarnings(params) {
	if (params.hits.length === 0) return [];
	return [`- ${sanitizeForLog(params.hits[0]?.path ?? "channels.telegram.apiRoot")} points at a full Telegram bot endpoint; apiRoot must be the Bot API root only. This can make startup calls like deleteWebhook, deleteMyCommands, and setMyCommands fail with 404 even when direct curl commands work.`, `- Run "${params.doctorFixCommand}" to remove the trailing /bot<TOKEN> path from Telegram apiRoot.`];
}
function formatTelegramAccountConfigPath(cfg, accountId) {
	const accounts = asObjectRecord(asObjectRecord(cfg.channels?.telegram)?.accounts);
	if (!accounts || Object.keys(accounts).length === 0) return "channels.telegram";
	return accountId === "default" ? "channels.telegram" : `channels.telegram.accounts.${accountId}`;
}
function scanTelegramSelectedQuoteToolProgressWarnings(cfg) {
	if (!asObjectRecord(cfg.channels?.telegram)) return [];
	return listTelegramAccountIds(cfg).flatMap((accountId) => {
		const account = mergeTelegramAccountConfig(cfg, accountId);
		const replyToMode = account.replyToMode ?? "off";
		if (replyToMode === "off") return [];
		if (resolveTelegramPreviewStreamMode(account) === "off") return [];
		if ((resolveChannelStreamingBlockEnabled(account) ?? cfg.agents?.defaults?.blockStreamingDefault === "on") || !resolveChannelStreamingPreviewToolProgress(account)) return [];
		return [{
			path: formatTelegramAccountConfigPath(cfg, accountId),
			replyToMode
		}];
	});
}
function collectTelegramSelectedQuoteToolProgressWarnings(params) {
	if (params.hits.length === 0) return [];
	const sample = params.hits[0] ?? {
		path: "channels.telegram",
		replyToMode: "first"
	};
	return [`- ${sanitizeForLog(sample.path)} has replyToMode: "${sanitizeForLog(sample.replyToMode)}" while Telegram preview tool-progress is enabled. Telegram selected quote replies must send the final answer through the native quote-reply path, so those turns skip the short "Working" tool-progress preview. Current-message replies without selected quote text still keep preview streaming.`, "- Set replyToMode: \"off\" when tool-progress preview matters more than native quote replies, or set streaming.preview.toolProgress: false to keep quote replies and silence this warning."];
}
function maybeRepairTelegramApiRoots(cfg) {
	const hits = scanTelegramBotEndpointApiRoots(cfg);
	if (hits.length === 0) return {
		config: cfg,
		changes: []
	};
	const next = structuredClone(cfg);
	const apply = (path, normalized) => {
		let target = next;
		for (const segment of path.slice(0, -1)) {
			target = asObjectRecord(target?.[segment]);
			if (!target) return;
		}
		target[path[path.length - 1] ?? "apiRoot"] = normalized;
	};
	for (const hit of hits) apply(hit.pathSegments, hit.normalized);
	return {
		config: next,
		changes: hits.map((hit) => `- ${sanitizeForLog(hit.path)}: removed trailing /bot<TOKEN> from Telegram apiRoot.`)
	};
}
function collectTelegramMissingEnvTokenWarnings(params) {
	if (resolveDefaultTelegramAccountId(params.cfg) !== "default") return [];
	const account = inspectTelegramAccount({
		cfg: params.cfg,
		accountId: "default",
		envToken: params.env?.TELEGRAM_BOT_TOKEN ?? ""
	});
	if (!account.enabled || account.tokenStatus !== "missing" || account.tokenSource !== "none") return [];
	return ["- channels.telegram: default account has no available bot token, and TELEGRAM_BOT_TOKEN is absent in this doctor environment. After migration, verify TELEGRAM_BOT_TOKEN is present in the state-dir .env or configure channels.telegram.botToken / channels.telegram.accounts.default.botToken as a SecretRef."];
}
async function repairTelegramConfig(params) {
	const apiRootRepair = maybeRepairTelegramApiRoots(params.cfg);
	const allowFromRepair = await maybeRepairTelegramAllowFromUsernames(apiRootRepair.config);
	return {
		config: allowFromRepair.config,
		changes: [...apiRootRepair.changes, ...allowFromRepair.changes]
	};
}
async function maybeRepairTelegramAllowFromUsernames(cfg) {
	const hits = scanTelegramInvalidAllowFromEntries(cfg);
	if (hits.length === 0) return {
		config: cfg,
		changes: []
	};
	if (hits.filter((hit) => {
		const normalized = normalizeTelegramAllowFromEntry(hit.entry);
		return normalized.length > 0 && !/\s/.test(normalized) && !normalized.startsWith("-");
	}).length === 0) return {
		config: cfg,
		changes: hits.slice(0, 5).map((hit) => `- ${sanitizeForLog(hit.path)}: invalid sender entry ${sanitizeForLog(hit.entry)}; allowFrom requires positive numeric Telegram user IDs. Move group chat IDs under channels.telegram.groups.`)
	};
	const { getChannelsCommandSecretTargetIds, resolveCommandSecretRefsViaGateway } = await import("./plugin-sdk/runtime.js");
	const { resolvedConfig } = await resolveCommandSecretRefsViaGateway({
		config: cfg,
		commandName: "doctor --fix",
		targetIds: getChannelsCommandSecretTargetIds(),
		mode: "read_only_status"
	});
	const tokenResolutionWarnings = [];
	const resolverAccountIds = [];
	let sawConfiguredUnavailableToken = false;
	for (const accountId of listTelegramAccountIds(resolvedConfig)) {
		let inspected;
		try {
			inspected = inspectTelegramAccount({
				cfg: resolvedConfig,
				accountId
			});
		} catch (error) {
			tokenResolutionWarnings.push(`- Telegram account ${accountId}: failed to inspect bot token (${formatErrorMessage(error)}).`);
			continue;
		}
		if (inspected.tokenStatus === "configured_unavailable") {
			sawConfiguredUnavailableToken = true;
			tokenResolutionWarnings.push(`- Telegram account ${accountId}: failed to inspect bot token (configured but unavailable in this command path).`);
		}
		if (inspected.tokenSource === "none" ? "" : normalizeOptionalString(inspected.token) ?? "") resolverAccountIds.push(accountId);
	}
	if (resolverAccountIds.length === 0) return {
		config: cfg,
		changes: [...tokenResolutionWarnings, sawConfiguredUnavailableToken ? "- Telegram allowFrom contains @username entries, but configured Telegram bot credentials are unavailable in this command path; cannot auto-resolve." : "- Telegram allowFrom contains @username entries, but no Telegram bot token is available in this command path; cannot auto-resolve."]
	};
	const resolveUserId = async (raw) => {
		const trimmed = normalizeOptionalString(raw) ?? "";
		if (!trimmed) return null;
		const normalized = normalizeTelegramAllowFromEntry(trimmed);
		if (!normalized || normalized === "*") return null;
		if (isNumericTelegramSenderUserId(normalized) || /\s/.test(normalized)) return isNumericTelegramSenderUserId(normalized) ? normalized : null;
		const username = normalized.startsWith("@") ? normalized : `@${normalized}`;
		for (const accountId of resolverAccountIds) try {
			const account = resolveTelegramAccount({
				cfg: resolvedConfig,
				accountId
			});
			const token = account.token.trim();
			if (!token) continue;
			const id = await lookupTelegramChatId({
				token,
				chatId: username,
				network: account.config.network,
				signal: void 0
			});
			if (id) return id;
		} catch {}
		return null;
	};
	const next = structuredClone(cfg);
	const changes = [];
	const repairList = async (pathLabel, holder, key) => {
		const raw = holder[key];
		if (!Array.isArray(raw)) return;
		const out = [];
		const replaced = [];
		for (const entry of raw) {
			const normalized = normalizeTelegramAllowFromEntry(entry);
			if (!normalized) continue;
			if (normalized === "*" || isNumericTelegramSenderUserId(normalized)) {
				out.push(normalized);
				continue;
			}
			const resolved = await resolveUserId(String(entry));
			if (resolved) {
				out.push(resolved);
				replaced.push({
					from: normalizeOptionalString(String(entry)) ?? "",
					to: resolved
				});
			} else out.push(normalizeOptionalString(String(entry)) ?? "");
		}
		const deduped = [];
		const seen = /* @__PURE__ */ new Set();
		for (const entry of out) {
			const keyValue = normalizeOptionalString(String(entry)) ?? "";
			if (!keyValue || seen.has(keyValue)) continue;
			seen.add(keyValue);
			deduped.push(entry);
		}
		holder[key] = deduped;
		for (const replacement of replaced.slice(0, 5)) changes.push(`- ${sanitizeForLog(pathLabel)}: resolved ${sanitizeForLog(replacement.from)} -> ${sanitizeForLog(replacement.to)}`);
		if (replaced.length > 5) changes.push(`- ${sanitizeForLog(pathLabel)}: resolved ${replaced.length - 5} more @username entries`);
	};
	for (const scope of collectTelegramAccountScopes(next)) for (const ref of collectTelegramAllowFromLists(scope.prefix, scope.account)) await repairList(ref.pathLabel, ref.holder, ref.key);
	if (changes.length === 0) return {
		config: cfg,
		changes: []
	};
	return {
		config: next,
		changes
	};
}
function hasConfiguredGroups(account, parent) {
	const groups = asObjectRecord(account.groups) ?? asObjectRecord(parent?.groups);
	return Boolean(groups) && Object.keys(groups ?? {}).length > 0;
}
function collectTelegramGroupPolicyWarnings(params) {
	if (!hasConfiguredGroups(params.account, params.parent)) {
		const effectiveDmPolicy = params.dmPolicy ?? "pairing";
		const dmSetupLine = effectiveDmPolicy === "pairing" ? "DMs use pairing mode, so new senders must start a chat and be approved before regular messages are accepted." : effectiveDmPolicy === "allowlist" ? `DMs use allowlist mode, so only sender IDs in ${params.prefix}.allowFrom are accepted.` : effectiveDmPolicy === "open" ? "DMs are open." : "DMs are disabled.";
		return [`- ${params.prefix}: Telegram is in first-time setup mode. ${dmSetupLine} Group messages stay blocked until you add allowed chats under ${params.prefix}.groups (and optional sender IDs under ${params.prefix}.groupAllowFrom), or set ${params.prefix}.groupPolicy to "open" if you want broad group access.`];
	}
	const rawGroupAllowFrom = params.account.groupAllowFrom ?? params.parent?.groupAllowFrom;
	if (hasAllowFromEntries((hasAllowFromEntries(rawGroupAllowFrom) ? rawGroupAllowFrom : void 0) ?? params.effectiveAllowFrom)) return [];
	return [`- ${params.prefix}.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to ${params.prefix}.groupAllowFrom or ${params.prefix}.allowFrom, or set ${params.prefix}.groupPolicy to "open".`];
}
function collectTelegramEmptyAllowlistExtraWarnings(params) {
	const account = params.account;
	const parent = params.parent;
	return params.channelName === "telegram" && (account.groupPolicy ?? parent?.groupPolicy ?? void 0) === "allowlist" ? collectTelegramGroupPolicyWarnings({
		account,
		dmPolicy: params.dmPolicy,
		effectiveAllowFrom: params.effectiveAllowFrom,
		parent,
		prefix: params.prefix
	}) : [];
}
const telegramDoctor = {
	legacyConfigRules,
	normalizeCompatibilityConfig,
	collectPreviewWarnings: ({ cfg, doctorFixCommand, env }) => [
		...collectTelegramMissingEnvTokenWarnings({
			cfg,
			env
		}),
		...collectTelegramMalformedGroupsWarnings({
			hits: scanTelegramMalformedGroupsConfig(cfg),
			doctorFixCommand
		}),
		...collectTelegramInvalidAllowFromWarnings({
			hits: scanTelegramInvalidAllowFromEntries(cfg),
			doctorFixCommand
		}),
		...collectTelegramApiRootWarnings({
			hits: scanTelegramBotEndpointApiRoots(cfg),
			doctorFixCommand
		}),
		...collectTelegramSelectedQuoteToolProgressWarnings({ hits: scanTelegramSelectedQuoteToolProgressWarnings(cfg) })
	],
	repairConfig: async ({ cfg }) => await repairTelegramConfig({ cfg }),
	collectEmptyAllowlistExtraWarnings: collectTelegramEmptyAllowlistExtraWarnings,
	shouldSkipDefaultEmptyGroupAllowlistWarning: (params) => params.channelName === "telegram"
};
//#endregion
//#region extensions/telegram/src/shared.ts
const TELEGRAM_CHANNEL = "telegram";
function findTelegramTokenOwnerAccountId(params) {
	const normalizedAccountId = normalizeAccountId(params.accountId);
	const tokenOwners = /* @__PURE__ */ new Map();
	for (const id of listTelegramAccountIds(params.cfg)) {
		const account = inspectTelegramAccount({
			cfg: params.cfg,
			accountId: id
		});
		const token = (account.token ?? "").trim();
		if (!token) continue;
		const ownerAccountId = tokenOwners.get(token);
		if (!ownerAccountId) {
			tokenOwners.set(token, account.accountId);
			continue;
		}
		if (account.accountId === normalizedAccountId) return ownerAccountId;
	}
	return null;
}
function formatDuplicateTelegramTokenReason(params) {
	return `Duplicate Telegram bot token: account "${params.accountId}" shares a token with account "${params.ownerAccountId}". Keep one owner account per bot token.`;
}
/**
* Returns true when the runtime token resolver (`resolveTelegramToken`) would
* block channel-level fallthrough for the given accountId.  This mirrors the
* guard in `token.ts` so that status-check functions (`isConfigured`,
* `unconfiguredReason`, `describeAccount`) stay consistent with the gateway
* runtime behaviour.
*
* The guard fires when:
*   1. The accountId is not the default account, AND
*   2. The config has an explicit `accounts` section with entries, AND
*   3. The accountId is not found in that `accounts` section.
*
* See: https://github.com/openclaw/openclaw/issues/53876
*/
function isBlockedByMultiBotGuard(cfg, accountId) {
	if (normalizeAccountId(accountId) === "default") return false;
	const accounts = cfg.channels?.telegram?.accounts;
	if (!(!!accounts && typeof accounts === "object" && !Array.isArray(accounts) && Object.keys(accounts).length > 0)) return false;
	return !resolveNormalizedAccountEntry(accounts, accountId, normalizeAccountId);
}
function resolveTelegramConfigAccessorAccount(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultTelegramAccountId(params.cfg));
	return { config: mergeTelegramAccountConfig(params.cfg, accountId) };
}
const telegramConfigAdapter = createScopedChannelConfigAdapter({
	sectionKey: TELEGRAM_CHANNEL,
	listAccountIds: listTelegramAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveTelegramAccount),
	resolveAccessorAccount: resolveTelegramConfigAccessorAccount,
	inspectAccount: adaptScopedAccountAccessor(inspectTelegramAccount),
	defaultAccountId: resolveDefaultTelegramAccountId,
	clearBaseFields: [
		"botToken",
		"tokenFile",
		"name"
	],
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({
		allowFrom,
		stripPrefixRe: /^(telegram|tg):/i
	}),
	resolveDefaultTo: (account) => account.config.defaultTo
});
function createTelegramPluginBase(params) {
	return {
		...createChannelPluginBase({
			id: TELEGRAM_CHANNEL,
			meta: {
				...getChatChannelMeta(TELEGRAM_CHANNEL),
				quickstartAllowFrom: true
			},
			setupWizard: params.setupWizard,
			capabilities: {
				chatTypes: [
					"direct",
					"group",
					"channel",
					"thread"
				],
				reactions: true,
				threads: true,
				media: true,
				tts: { voice: { synthesisTarget: "voice-note" } },
				polls: true,
				nativeCommands: true,
				blockStreaming: true
			},
			commands: {
				nativeCommandsAutoEnabled: true,
				nativeSkillsAutoEnabled: true,
				buildCommandsListChannelData: buildTelegramCommandsListChannelData,
				buildModelsMenuChannelData: buildTelegramModelsMenuChannelData,
				buildModelsProviderChannelData: buildTelegramModelsProviderChannelData,
				buildModelsAddProviderChannelData: buildTelegramModelsAddProviderChannelData,
				buildModelsListChannelData: buildTelegramModelsListChannelData,
				buildModelBrowseChannelData: buildTelegramModelBrowseChannelData
			},
			doctor: telegramDoctor,
			security: telegramSecurityAdapter,
			reload: { configPrefixes: ["channels.telegram"] },
			configSchema: TelegramChannelConfigSchema,
			config: {
				...telegramConfigAdapter,
				hasConfiguredState: ({ env }) => typeof env?.TELEGRAM_BOT_TOKEN === "string" && env.TELEGRAM_BOT_TOKEN.trim().length > 0,
				isConfigured: (account, cfg) => {
					if (isBlockedByMultiBotGuard(cfg, account.accountId)) return false;
					if (!inspectTelegramAccount({
						cfg,
						accountId: account.accountId
					}).token?.trim()) return false;
					return !findTelegramTokenOwnerAccountId({
						cfg,
						accountId: account.accountId
					});
				},
				unconfiguredReason: (account, cfg) => {
					if (isBlockedByMultiBotGuard(cfg, account.accountId)) return `not configured: unknown accountId "${account.accountId}" in multi-bot setup`;
					const inspected = inspectTelegramAccount({
						cfg,
						accountId: account.accountId
					});
					if (!inspected.token?.trim()) {
						if (inspected.tokenStatus === "configured_unavailable") return `not configured: token ${inspected.tokenSource} is configured but unavailable`;
						return "not configured";
					}
					const ownerAccountId = findTelegramTokenOwnerAccountId({
						cfg,
						accountId: account.accountId
					});
					if (!ownerAccountId) return "not configured";
					return formatDuplicateTelegramTokenReason({
						accountId: account.accountId,
						ownerAccountId
					});
				},
				describeAccount: (account, cfg) => {
					if (isBlockedByMultiBotGuard(cfg, account.accountId)) return {
						accountId: account.accountId,
						name: account.name,
						enabled: account.enabled,
						configured: false,
						tokenSource: "none"
					};
					const inspected = inspectTelegramAccount({
						cfg,
						accountId: account.accountId
					});
					return {
						accountId: account.accountId,
						name: account.name,
						enabled: account.enabled,
						configured: !!inspected.token?.trim() && !findTelegramTokenOwnerAccountId({
							cfg,
							accountId: account.accountId
						}),
						tokenSource: inspected.tokenSource
					};
				}
			},
			setup: {
				...params.setup,
				namedAccountPromotionKeys,
				singleAccountKeysToMove
			}
		}),
		secrets: {
			secretTargetRegistryEntries,
			collectRuntimeConfigAssignments
		}
	};
}
//#endregion
//#region extensions/telegram/src/channel.setup.ts
const telegramSetupPlugin = {
	...createTelegramPluginBase({
		setupWizard: telegramSetupWizard,
		setup: telegramSetupAdapter
	}),
	lifecycle: { detectLegacyStateMigrations: ({ cfg, env }) => detectTelegramLegacyStateMigrations({
		cfg,
		env
	}) }
};
//#endregion
export { telegramConfigAdapter as a, telegramSecurityAdapter as c, resolveTelegramChatLookupFetch as d, formatDuplicateTelegramTokenReason as i, fetchTelegramChatId as l, createTelegramPluginBase as n, telegramSetupWizard as o, findTelegramTokenOwnerAccountId as r, telegramSetupAdapter as s, telegramSetupPlugin as t, lookupTelegramChatId as u };
