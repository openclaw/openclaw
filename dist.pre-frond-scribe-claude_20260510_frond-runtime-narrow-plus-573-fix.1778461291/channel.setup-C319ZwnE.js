import { s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "./channel-config-helpers-C5msK1mQ.js";
import { t as formatAllowFromLowercase } from "./allow-from-D-3-vc_R.js";
import { a as resolveSlackAccount, c as resolveSlackConfigAccessorAccount, i as resolveDefaultSlackAccountId, n as listSlackAccountIds } from "./accounts-DJWYx_8o.js";
import { a as describeSlackSetupAccount, i as SLACK_CHANNEL, n as createSlackSetupWizardProxy, o as isSlackSetupAccountConfigured, r as slackSetupAdapter } from "./setup-core-DsfeMhBm.js";
import { t as SlackChannelConfigSchema } from "./config-schema-C6sktl00.js";
//#region extensions/slack/src/channel.setup.ts
const slackSetupWizard = createSlackSetupWizardProxy(async () => ({ slackSetupWizard: (await import("./setup-surface-CwdxXtke.js")).slackSetupWizard }));
const slackSetupConfigAdapter = createScopedChannelConfigAdapter({
	sectionKey: SLACK_CHANNEL,
	listAccountIds: listSlackAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveSlackAccount),
	resolveAccessorAccount: resolveSlackConfigAccessorAccount,
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
const slackSetupPlugin = {
	id: SLACK_CHANNEL,
	meta: {
		id: SLACK_CHANNEL,
		label: "Slack",
		selectionLabel: "Slack (Socket Mode)",
		detailLabel: "Slack Bot",
		docsPath: "/channels/slack",
		docsLabel: "slack",
		blurb: "supported (Socket Mode).",
		systemImage: "number",
		markdownCapable: true,
		preferSessionLookupForAnnounceTarget: true
	},
	setupWizard: slackSetupWizard,
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
	streaming: { blockStreamingCoalesceDefaults: {
		minChars: 1500,
		idleMs: 1e3
	} },
	reload: { configPrefixes: ["channels.slack"] },
	configSchema: SlackChannelConfigSchema,
	config: {
		...slackSetupConfigAdapter,
		hasConfiguredState: ({ env }) => [
			"SLACK_APP_TOKEN",
			"SLACK_BOT_TOKEN",
			"SLACK_USER_TOKEN"
		].some((key) => typeof env?.[key] === "string" && env[key]?.trim().length > 0),
		isConfigured: (account) => isSlackSetupAccountConfigured(account),
		describeAccount: (account) => describeSlackSetupAccount(account)
	},
	setup: slackSetupAdapter
};
//#endregion
export { slackSetupPlugin as t };
