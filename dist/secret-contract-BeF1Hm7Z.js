import { i as hasOwnProperty } from "./runtime-shared-CPFXAPqc.js";
import { a as getChannelSurface, t as collectConditionalChannelFieldAssignments } from "./channel-secret-basic-runtime-CU0qW-Ow.js";
import "./channel-secret-basic-runtime-eKiftYvE.js";
//#region extensions/zalo/src/secret-contract.ts
const secretTargetRegistryEntries = [
	{
		id: "channels.zalo.accounts.*.botToken",
		targetType: "channels.zalo.accounts.*.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.zalo.accounts.*.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.zalo.accounts.*.webhookSecret",
		targetType: "channels.zalo.accounts.*.webhookSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.zalo.accounts.*.webhookSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.zalo.botToken",
		targetType: "channels.zalo.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.zalo.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.zalo.webhookSecret",
		targetType: "channels.zalo.webhookSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.zalo.webhookSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	}
];
function collectRuntimeConfigAssignments(params) {
	const resolved = getChannelSurface(params.config, "zalo");
	if (!resolved) return;
	const { channel: zalo, surface } = resolved;
	collectConditionalChannelFieldAssignments({
		channelKey: "zalo",
		field: "botToken",
		channel: zalo,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActiveWithoutAccounts: true,
		topLevelInheritedAccountActive: ({ account, enabled }) => enabled && !hasOwnProperty(account, "botToken"),
		accountActive: ({ enabled }) => enabled,
		topInactiveReason: "no enabled Zalo surface inherits this top-level botToken.",
		accountInactiveReason: "Zalo account is disabled."
	});
	const baseWebhookUrl = typeof zalo.webhookUrl === "string" ? zalo.webhookUrl.trim() : "";
	const accountWebhookUrl = (account) => hasOwnProperty(account, "webhookUrl") ? typeof account.webhookUrl === "string" ? account.webhookUrl.trim() : "" : baseWebhookUrl;
	collectConditionalChannelFieldAssignments({
		channelKey: "zalo",
		field: "webhookSecret",
		channel: zalo,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActiveWithoutAccounts: baseWebhookUrl.length > 0,
		topLevelInheritedAccountActive: ({ account, enabled }) => enabled && !hasOwnProperty(account, "webhookSecret") && accountWebhookUrl(account).length > 0,
		accountActive: ({ account, enabled }) => enabled && accountWebhookUrl(account).length > 0,
		topInactiveReason: "no enabled Zalo webhook surface inherits this top-level webhookSecret (webhook mode is not active).",
		accountInactiveReason: "Zalo account is disabled or webhook mode is not active for this account."
	});
}
const channelSecrets = {
	secretTargetRegistryEntries,
	collectRuntimeConfigAssignments
};
//#endregion
export { collectRuntimeConfigAssignments as n, secretTargetRegistryEntries as r, channelSecrets as t };
