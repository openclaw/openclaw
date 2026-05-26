import { i as hasOwnProperty } from "./runtime-shared-CizWAYqZ.js";
import { a as getChannelSurface, r as collectSimpleChannelFieldAssignments, t as collectConditionalChannelFieldAssignments } from "./channel-secret-basic-runtime-Dcd_-sVX.js";
import "./channel-secret-basic-runtime-D51jwBxk.js";
//#region extensions/slack/src/secret-contract.ts
const secretTargetRegistryEntries = [
	{
		id: "channels.slack.accounts.*.appToken",
		targetType: "channels.slack.accounts.*.appToken",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.accounts.*.appToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.accounts.*.botToken",
		targetType: "channels.slack.accounts.*.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.accounts.*.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.accounts.*.signingSecret",
		targetType: "channels.slack.accounts.*.signingSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.accounts.*.signingSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.accounts.*.userToken",
		targetType: "channels.slack.accounts.*.userToken",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.accounts.*.userToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.appToken",
		targetType: "channels.slack.appToken",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.appToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.botToken",
		targetType: "channels.slack.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.signingSecret",
		targetType: "channels.slack.signingSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.signingSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.userToken",
		targetType: "channels.slack.userToken",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.userToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	}
];
function collectRuntimeConfigAssignments(params) {
	const resolved = getChannelSurface(params.config, "slack");
	if (!resolved) return;
	const { channel: slack, surface } = resolved;
	const baseMode = slack.mode === "http" || slack.mode === "socket" ? slack.mode : "socket";
	for (const field of ["botToken", "userToken"]) collectSimpleChannelFieldAssignments({
		channelKey: "slack",
		field,
		channel: slack,
		surface,
		defaults: params.defaults,
		context: params.context,
		topInactiveReason: `no enabled account inherits this top-level Slack ${field}.`,
		accountInactiveReason: "Slack account is disabled."
	});
	const resolveAccountMode = (account) => account.mode === "http" || account.mode === "socket" ? account.mode : baseMode;
	collectConditionalChannelFieldAssignments({
		channelKey: "slack",
		field: "appToken",
		channel: slack,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActiveWithoutAccounts: baseMode !== "http",
		topLevelInheritedAccountActive: ({ account, enabled }) => enabled && !hasOwnProperty(account, "appToken") && resolveAccountMode(account) !== "http",
		accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) !== "http",
		topInactiveReason: "no enabled Slack socket-mode surface inherits this top-level appToken.",
		accountInactiveReason: "Slack account is disabled or not running in socket mode."
	});
	collectConditionalChannelFieldAssignments({
		channelKey: "slack",
		field: "signingSecret",
		channel: slack,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActiveWithoutAccounts: baseMode === "http",
		topLevelInheritedAccountActive: ({ account, enabled }) => enabled && !hasOwnProperty(account, "signingSecret") && resolveAccountMode(account) === "http",
		accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "http",
		topInactiveReason: "no enabled Slack HTTP-mode surface inherits this top-level signingSecret.",
		accountInactiveReason: "Slack account is disabled or not running in HTTP mode."
	});
}
const channelSecrets = {
	secretTargetRegistryEntries,
	collectRuntimeConfigAssignments
};
//#endregion
export { collectRuntimeConfigAssignments as n, secretTargetRegistryEntries as r, channelSecrets as t };
