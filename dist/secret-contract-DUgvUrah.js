import { i as hasOwnProperty } from "./runtime-shared-CPFXAPqc.js";
import { a as getChannelSurface, t as collectConditionalChannelFieldAssignments } from "./channel-secret-basic-runtime-CU0qW-Ow.js";
import "./channel-secret-basic-runtime-eKiftYvE.js";
//#region extensions/nextcloud-talk/src/secret-contract.ts
const secretTargetRegistryEntries = [
	{
		id: "channels.nextcloud-talk.accounts.*.apiPassword",
		targetType: "channels.nextcloud-talk.accounts.*.apiPassword",
		configFile: "openclaw.json",
		pathPattern: "channels.nextcloud-talk.accounts.*.apiPassword",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.nextcloud-talk.accounts.*.botSecret",
		targetType: "channels.nextcloud-talk.accounts.*.botSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.nextcloud-talk.accounts.*.botSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.nextcloud-talk.apiPassword",
		targetType: "channels.nextcloud-talk.apiPassword",
		configFile: "openclaw.json",
		pathPattern: "channels.nextcloud-talk.apiPassword",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.nextcloud-talk.botSecret",
		targetType: "channels.nextcloud-talk.botSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.nextcloud-talk.botSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	}
];
function collectRuntimeConfigAssignments(params) {
	const resolved = getChannelSurface(params.config, "nextcloud-talk");
	if (!resolved) return;
	const { channel: nextcloudTalk, surface } = resolved;
	const inheritsField = (field) => ({ account, enabled }) => enabled && !hasOwnProperty(account, field);
	collectConditionalChannelFieldAssignments({
		channelKey: "nextcloud-talk",
		field: "botSecret",
		channel: nextcloudTalk,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActiveWithoutAccounts: true,
		topLevelInheritedAccountActive: inheritsField("botSecret"),
		accountActive: ({ enabled }) => enabled,
		topInactiveReason: "no enabled Nextcloud Talk surface inherits this top-level botSecret.",
		accountInactiveReason: "Nextcloud Talk account is disabled."
	});
	collectConditionalChannelFieldAssignments({
		channelKey: "nextcloud-talk",
		field: "apiPassword",
		channel: nextcloudTalk,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActiveWithoutAccounts: true,
		topLevelInheritedAccountActive: inheritsField("apiPassword"),
		accountActive: ({ enabled }) => enabled,
		topInactiveReason: "no enabled Nextcloud Talk surface inherits this top-level apiPassword.",
		accountInactiveReason: "Nextcloud Talk account is disabled."
	});
}
const channelSecrets = {
	secretTargetRegistryEntries,
	collectRuntimeConfigAssignments
};
//#endregion
export { collectRuntimeConfigAssignments as n, secretTargetRegistryEntries as r, channelSecrets as t };
