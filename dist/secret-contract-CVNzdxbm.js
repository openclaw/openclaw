import { i as hasOwnProperty } from "./runtime-shared-CPFXAPqc.js";
import { a as getChannelSurface, c as normalizeSecretStringValue, r as collectSimpleChannelFieldAssignments, t as collectConditionalChannelFieldAssignments } from "./channel-secret-basic-runtime-CU0qW-Ow.js";
import "./channel-secret-basic-runtime-eKiftYvE.js";
//#region extensions/feishu/src/secret-contract.ts
const secretTargetRegistryEntries = [
	{
		id: "channels.feishu.accounts.*.appSecret",
		targetType: "channels.feishu.accounts.*.appSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.feishu.accounts.*.appSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.feishu.accounts.*.encryptKey",
		targetType: "channels.feishu.accounts.*.encryptKey",
		configFile: "openclaw.json",
		pathPattern: "channels.feishu.accounts.*.encryptKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.feishu.accounts.*.verificationToken",
		targetType: "channels.feishu.accounts.*.verificationToken",
		configFile: "openclaw.json",
		pathPattern: "channels.feishu.accounts.*.verificationToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.feishu.appSecret",
		targetType: "channels.feishu.appSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.feishu.appSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.feishu.encryptKey",
		targetType: "channels.feishu.encryptKey",
		configFile: "openclaw.json",
		pathPattern: "channels.feishu.encryptKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.feishu.verificationToken",
		targetType: "channels.feishu.verificationToken",
		configFile: "openclaw.json",
		pathPattern: "channels.feishu.verificationToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	}
];
function collectRuntimeConfigAssignments(params) {
	const resolved = getChannelSurface(params.config, "feishu");
	if (!resolved) return;
	const { channel: feishu, surface } = resolved;
	collectSimpleChannelFieldAssignments({
		channelKey: "feishu",
		field: "appSecret",
		channel: feishu,
		surface,
		defaults: params.defaults,
		context: params.context,
		topInactiveReason: "no enabled account inherits this top-level Feishu appSecret.",
		accountInactiveReason: "Feishu account is disabled."
	});
	const baseConnectionMode = normalizeSecretStringValue(feishu.connectionMode) === "webhook" ? "webhook" : "websocket";
	const resolveAccountMode = (account) => hasOwnProperty(account, "connectionMode") ? normalizeSecretStringValue(account.connectionMode) : baseConnectionMode;
	collectConditionalChannelFieldAssignments({
		channelKey: "feishu",
		field: "encryptKey",
		channel: feishu,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActiveWithoutAccounts: baseConnectionMode === "webhook",
		topLevelInheritedAccountActive: ({ account, enabled }) => enabled && !hasOwnProperty(account, "encryptKey") && resolveAccountMode(account) === "webhook",
		accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "webhook",
		topInactiveReason: "no enabled Feishu webhook-mode surface inherits this top-level encryptKey.",
		accountInactiveReason: "Feishu account is disabled or not running in webhook mode."
	});
	collectConditionalChannelFieldAssignments({
		channelKey: "feishu",
		field: "verificationToken",
		channel: feishu,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActiveWithoutAccounts: baseConnectionMode === "webhook",
		topLevelInheritedAccountActive: ({ account, enabled }) => enabled && !hasOwnProperty(account, "verificationToken") && resolveAccountMode(account) === "webhook",
		accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "webhook",
		topInactiveReason: "no enabled Feishu webhook-mode surface inherits this top-level verificationToken.",
		accountInactiveReason: "Feishu account is disabled or not running in webhook mode."
	});
}
const channelSecrets = {
	secretTargetRegistryEntries,
	collectRuntimeConfigAssignments
};
//#endregion
export { collectRuntimeConfigAssignments as n, secretTargetRegistryEntries as r, channelSecrets as t };
