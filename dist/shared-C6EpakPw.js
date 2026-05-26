import { r as createLazyRuntimeModule } from "./lazy-runtime-Dh47Iq4d.js";
import { l as createScopedDmSecurityResolver, s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "./channel-config-helpers-Dzal6cfS.js";
import { n as describeAccountSnapshot } from "./account-helpers-Ba4hZbOH.js";
import { t as formatAllowFromLowercase } from "./allow-from-CFKhmZbv.js";
import { S as createOpenProviderConfiguredRouteWarningCollector, n as createDangerousNameMatchingMutableAllowlistWarningCollector } from "./channel-policy-DorgJeIC.js";
import { a as resolveSlackAccount, c as resolveSlackConfigAccessorAccount, i as resolveDefaultSlackAccountId, n as listSlackAccountIds, o as resolveSlackAccountAllowFrom, s as resolveSlackAccountDmPolicy } from "./accounts-Ba1LnRZV.js";
import { t as inspectSlackAccount } from "./account-inspect-C_aP3mS7.js";
import { n as isSlackInteractiveRepliesEnabled } from "./interactive-replies-DNuhlh3P.js";
import { t as getChatChannelMeta } from "./channel-api-ByraXVye.js";
import { i as SLACK_CHANNEL } from "./setup-core-VYPiralZ.js";
import { t as SlackChannelConfigSchema } from "./config-schema-yuQhIpwc.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "./doctor-contract-BqCseZAf.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "./secret-contract-kUrPshE0.js";
//#region extensions/slack/src/security.ts
const resolveSlackDmPolicy = createScopedDmSecurityResolver({
	channelKey: "slack",
	resolvePolicy: (account) => account.config.dmPolicy,
	resolveAllowFrom: (account) => account.config.allowFrom,
	resolveAccess: ({ cfg, account }) => ({
		dmPolicy: resolveSlackAccountDmPolicy({
			cfg,
			accountId: account.accountId
		}),
		allowFrom: resolveSlackAccountAllowFrom({
			cfg,
			accountId: account.accountId
		})
	}),
	policyPathSuffix: "dmPolicy",
	normalizeEntry: (raw) => raw.trim().replace(/^(slack|user):/i, "").trim()
});
const collectSlackSecurityWarnings = createOpenProviderConfiguredRouteWarningCollector({
	providerConfigPresent: (cfg) => cfg.channels?.slack !== void 0,
	resolveGroupPolicy: (account) => account.config.groupPolicy,
	resolveRouteAllowlistConfigured: (account) => Boolean(account.config.channels) && Object.keys(account.config.channels ?? {}).length > 0,
	configureRouteAllowlist: {
		surface: "Slack channels",
		openScope: "any channel not explicitly denied",
		groupPolicyPath: "channels.slack.groupPolicy",
		routeAllowlistPath: "channels.slack.channels"
	},
	missingRouteAllowlist: {
		surface: "Slack channels",
		openBehavior: "with no channel allowlist; any channel can trigger (mention-gated)",
		remediation: "Set channels.slack.groupPolicy=\"allowlist\" and configure channels.slack.channels"
	}
});
const loadSlackSecurityAuditModule = createLazyRuntimeModule(() => import("./security-audit-BJQySJ6g.js"));
const slackSecurityAdapter = {
	resolveDmPolicy: resolveSlackDmPolicy,
	collectWarnings: collectSlackSecurityWarnings,
	collectAuditFindings: async (params) => {
		const { collectSlackSecurityAuditFindings } = await loadSlackSecurityAuditModule();
		return await collectSlackSecurityAuditFindings(params);
	}
};
//#endregion
//#region extensions/slack/src/security-doctor.ts
function isSlackMutableAllowEntry(raw) {
	const text = raw.trim();
	if (!text || text === "*") return false;
	const mentionMatch = text.match(/^<@([A-Z0-9]+)>$/i);
	if (mentionMatch && /^[A-Z0-9]{8,}$/i.test(mentionMatch[1] ?? "")) return false;
	const withoutPrefix = text.replace(/^(slack|user):/i, "").trim();
	if (/^[UWBCGDT][A-Z0-9]{2,}$/.test(withoutPrefix)) return false;
	if (/^[A-Z0-9]{8,}$/i.test(withoutPrefix)) return false;
	return true;
}
//#endregion
//#region extensions/slack/src/doctor.ts
function asObjectRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
const slackDoctor = {
	dmAllowFromMode: "topOnly",
	groupModel: "route",
	groupAllowFromFallbackToAllowFrom: false,
	warnOnEmptyGroupSenderAllowlist: false,
	legacyConfigRules,
	normalizeCompatibilityConfig,
	collectMutableAllowlistWarnings: createDangerousNameMatchingMutableAllowlistWarningCollector({
		channel: "slack",
		detector: isSlackMutableAllowEntry,
		collectLists: (scope) => {
			const lists = [{
				pathLabel: `${scope.prefix}.allowFrom`,
				list: scope.account.allowFrom
			}];
			const dm = asObjectRecord(scope.account.dm);
			if (dm) lists.push({
				pathLabel: `${scope.prefix}.dm.allowFrom`,
				list: dm.allowFrom
			});
			const channels = asObjectRecord(scope.account.channels);
			if (channels) for (const [channelKey, channelRaw] of Object.entries(channels)) {
				const channel = asObjectRecord(channelRaw);
				if (!channel) continue;
				lists.push({
					pathLabel: `${scope.prefix}.channels.${channelKey}.users`,
					list: channel.users
				});
			}
			return lists;
		}
	})
};
//#endregion
//#region extensions/slack/src/shared.ts
function isSlackPluginAccountConfigured(account) {
	const mode = account.config.mode ?? "socket";
	if (!Boolean(account.botToken?.trim())) return false;
	if (mode === "http") return Boolean(account.config.signingSecret?.trim());
	return Boolean(account.appToken?.trim());
}
const slackConfigAdapter = createScopedChannelConfigAdapter({
	sectionKey: SLACK_CHANNEL,
	listAccountIds: listSlackAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveSlackAccount),
	resolveAccessorAccount: resolveSlackConfigAccessorAccount,
	inspectAccount: adaptScopedAccountAccessor(inspectSlackAccount),
	defaultAccountId: resolveDefaultSlackAccountId,
	clearBaseFields: [
		"botToken",
		"appToken",
		"name"
	],
	resolveAllowFrom: (account) => account.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
	resolveDefaultTo: (account) => account.defaultTo
});
function createSlackPluginBase(params) {
	return {
		id: SLACK_CHANNEL,
		meta: {
			...getChatChannelMeta(SLACK_CHANNEL),
			preferSessionLookupForAnnounceTarget: true
		},
		setupWizard: params.setupWizard,
		capabilities: {
			chatTypes: [
				"direct",
				"channel",
				"thread"
			],
			reactions: true,
			threads: true,
			media: true,
			nativeCommands: true
		},
		commands: {
			nativeCommandsAutoEnabled: false,
			nativeSkillsAutoEnabled: false,
			resolveNativeCommandName: ({ commandKey, defaultName }) => commandKey === "status" ? "agentstatus" : defaultName
		},
		doctor: slackDoctor,
		agentPrompt: {
			inboundFormattingHints: () => ({
				text_markup: "slack_mrkdwn",
				rules: [
					"Use Slack mrkdwn, not standard Markdown.",
					"Bold uses *single asterisks*.",
					"Links use <url|label>.",
					"Code blocks use triple backticks without a language identifier.",
					"Do not use markdown headings or pipe tables."
				]
			}),
			messageToolHints: ({ cfg, accountId }) => (isSlackInteractiveRepliesEnabled({
				cfg,
				accountId
			}) ? [
				"- Prefer Slack buttons/selects for 2-5 discrete choices or parameter picks instead of asking the user to type one.",
				"- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.",
				"- Slack selects: use `[[slack_select: Placeholder | Label:value, Other:other]]` to add a static select menu that routes the chosen value back as a Slack interaction system event."
			] : ["- Slack interactive replies are disabled. If needed, ask to set `channels.slack.capabilities.interactiveReplies=true` (or the same under `channels.slack.accounts.<account>.capabilities`)."]).concat(["- Slack plain text sends: write standard Markdown; OpenClaw converts it to Slack mrkdwn, including `**bold**`, headings, lists, and `[label](url)` links.", "- Slack Block Kit or presentation text fields are sent as Slack mrkdwn directly; use `*bold*`, `_italic_`, `~strike~`, `<url|label>` links, and avoid Markdown headings or pipe tables there."])
		},
		streaming: { blockStreamingCoalesceDefaults: {
			minChars: 1500,
			idleMs: 1e3
		} },
		reload: { configPrefixes: ["channels.slack"] },
		security: slackSecurityAdapter,
		configSchema: SlackChannelConfigSchema,
		config: {
			...slackConfigAdapter,
			hasConfiguredState: ({ env }) => [
				"SLACK_APP_TOKEN",
				"SLACK_BOT_TOKEN",
				"SLACK_USER_TOKEN"
			].some((key) => typeof env?.[key] === "string" && env[key]?.trim().length > 0),
			isConfigured: (account) => isSlackPluginAccountConfigured(account),
			describeAccount: (account) => describeAccountSnapshot({
				account,
				configured: isSlackPluginAccountConfigured(account),
				extra: {
					botTokenSource: account.botTokenSource,
					appTokenSource: account.appTokenSource
				}
			})
		},
		secrets: {
			secretTargetRegistryEntries,
			collectRuntimeConfigAssignments
		},
		setup: params.setup
	};
}
//#endregion
export { slackSecurityAdapter as i, isSlackPluginAccountConfigured as n, slackConfigAdapter as r, createSlackPluginBase as t };
