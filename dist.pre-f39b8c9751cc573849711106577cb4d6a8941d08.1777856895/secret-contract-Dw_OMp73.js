import { a as getChannelSurface, r as collectSimpleChannelFieldAssignments } from "./channel-secret-basic-runtime-BibzRmdb.js";
import "./channel-secret-basic-runtime-Bhnp2e3C.js";
//#region extensions/bluebubbles/src/secret-contract.ts
const secretTargetRegistryEntries = [{
	id: "channels.bluebubbles.accounts.*.password",
	targetType: "channels.bluebubbles.accounts.*.password",
	configFile: "openclaw.json",
	pathPattern: "channels.bluebubbles.accounts.*.password",
	secretShape: "secret_input",
	expectedResolvedValue: "string",
	includeInPlan: true,
	includeInConfigure: true,
	includeInAudit: true
}, {
	id: "channels.bluebubbles.password",
	targetType: "channels.bluebubbles.password",
	configFile: "openclaw.json",
	pathPattern: "channels.bluebubbles.password",
	secretShape: "secret_input",
	expectedResolvedValue: "string",
	includeInPlan: true,
	includeInConfigure: true,
	includeInAudit: true
}];
function collectRuntimeConfigAssignments(params) {
	const resolved = getChannelSurface(params.config, "bluebubbles");
	if (!resolved) return;
	const { channel: bluebubbles, surface } = resolved;
	collectSimpleChannelFieldAssignments({
		channelKey: "bluebubbles",
		field: "password",
		channel: bluebubbles,
		surface,
		defaults: params.defaults,
		context: params.context,
		topInactiveReason: "no enabled account inherits this top-level BlueBubbles password.",
		accountInactiveReason: "BlueBubbles account is disabled."
	});
}
const channelSecrets = {
	secretTargetRegistryEntries,
	collectRuntimeConfigAssignments
};
//#endregion
export { collectRuntimeConfigAssignments as n, secretTargetRegistryEntries as r, channelSecrets as t };
