import { a as getChannelSurface, r as collectSimpleChannelFieldAssignments } from "./channel-secret-basic-runtime-CU0qW-Ow.js";
import "./channel-secret-basic-runtime-eKiftYvE.js";
//#region extensions/mattermost/src/secret-contract.ts
const secretTargetRegistryEntries = [{
	id: "channels.mattermost.accounts.*.botToken",
	targetType: "channels.mattermost.accounts.*.botToken",
	configFile: "openclaw.json",
	pathPattern: "channels.mattermost.accounts.*.botToken",
	secretShape: "secret_input",
	expectedResolvedValue: "string",
	includeInPlan: true,
	includeInConfigure: true,
	includeInAudit: true
}, {
	id: "channels.mattermost.botToken",
	targetType: "channels.mattermost.botToken",
	configFile: "openclaw.json",
	pathPattern: "channels.mattermost.botToken",
	secretShape: "secret_input",
	expectedResolvedValue: "string",
	includeInPlan: true,
	includeInConfigure: true,
	includeInAudit: true
}];
function collectRuntimeConfigAssignments(params) {
	const resolved = getChannelSurface(params.config, "mattermost");
	if (!resolved) return;
	const { channel: mattermost, surface } = resolved;
	collectSimpleChannelFieldAssignments({
		channelKey: "mattermost",
		field: "botToken",
		channel: mattermost,
		surface,
		defaults: params.defaults,
		context: params.context,
		topInactiveReason: "no enabled account inherits this top-level Mattermost botToken.",
		accountInactiveReason: "Mattermost account is disabled."
	});
}
const channelSecrets = {
	secretTargetRegistryEntries,
	collectRuntimeConfigAssignments
};
//#endregion
export { collectRuntimeConfigAssignments as n, secretTargetRegistryEntries as r, channelSecrets as t };
