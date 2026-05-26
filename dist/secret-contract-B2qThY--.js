import { i as hasOwnProperty } from "./runtime-shared-CPFXAPqc.js";
import { a as getChannelSurface, o as hasConfiguredSecretInputValue, t as collectConditionalChannelFieldAssignments } from "./channel-secret-basic-runtime-CU0qW-Ow.js";
import "./channel-secret-basic-runtime-eKiftYvE.js";
//#region extensions/telegram/src/secret-contract.ts
function normalizeOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
const secretTargetRegistryEntries = [
	{
		id: "channels.telegram.accounts.*.botToken",
		targetType: "channels.telegram.accounts.*.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.telegram.accounts.*.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.telegram.accounts.*.webhookSecret",
		targetType: "channels.telegram.accounts.*.webhookSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.telegram.accounts.*.webhookSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.telegram.botToken",
		targetType: "channels.telegram.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.telegram.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.telegram.webhookSecret",
		targetType: "channels.telegram.webhookSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.telegram.webhookSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	}
];
function collectRuntimeConfigAssignments(params) {
	const resolved = getChannelSurface(params.config, "telegram");
	if (!resolved) return;
	const { channel: telegram, surface } = resolved;
	const baseTokenFile = normalizeOptionalString(telegram.tokenFile) ?? "";
	const accountTokenFile = (account) => normalizeOptionalString(account.tokenFile) ?? "";
	collectConditionalChannelFieldAssignments({
		channelKey: "telegram",
		field: "botToken",
		channel: telegram,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActiveWithoutAccounts: baseTokenFile.length === 0,
		topLevelInheritedAccountActive: ({ account, enabled }) => {
			if (!enabled || baseTokenFile.length > 0) return false;
			return !hasConfiguredSecretInputValue(account.botToken, params.defaults) && accountTokenFile(account).length === 0;
		},
		accountActive: ({ account, enabled }) => enabled && accountTokenFile(account).length === 0,
		topInactiveReason: "no enabled Telegram surface inherits this top-level botToken (tokenFile is configured).",
		accountInactiveReason: "Telegram account is disabled or tokenFile is configured."
	});
	const baseWebhookUrl = normalizeOptionalString(telegram.webhookUrl) ?? "";
	const accountWebhookUrl = (account) => hasOwnProperty(account, "webhookUrl") ? normalizeOptionalString(account.webhookUrl) ?? "" : baseWebhookUrl;
	collectConditionalChannelFieldAssignments({
		channelKey: "telegram",
		field: "webhookSecret",
		channel: telegram,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActiveWithoutAccounts: baseWebhookUrl.length > 0,
		topLevelInheritedAccountActive: ({ account, enabled }) => enabled && !hasOwnProperty(account, "webhookSecret") && accountWebhookUrl(account).length > 0,
		accountActive: ({ account, enabled }) => enabled && accountWebhookUrl(account).length > 0,
		topInactiveReason: "no enabled Telegram webhook surface inherits this top-level webhookSecret (webhook mode is not active).",
		accountInactiveReason: "Telegram account is disabled or webhook mode is not active for this account."
	});
}
const channelSecrets = {
	secretTargetRegistryEntries,
	collectRuntimeConfigAssignments
};
//#endregion
export { collectRuntimeConfigAssignments as n, secretTargetRegistryEntries as r, channelSecrets as t };
