import { n as collectSecretInputAssignment } from "./runtime-shared-CPFXAPqc.js";
import { i as getChannelRecord } from "./channel-secret-basic-runtime-CU0qW-Ow.js";
import "./channel-secret-basic-runtime-eKiftYvE.js";
//#region extensions/msteams/src/secret-contract.ts
const secretTargetRegistryEntries = [{
	id: "channels.msteams.appPassword",
	targetType: "channels.msteams.appPassword",
	configFile: "openclaw.json",
	pathPattern: "channels.msteams.appPassword",
	secretShape: "secret_input",
	expectedResolvedValue: "string",
	includeInPlan: true,
	includeInConfigure: true,
	includeInAudit: true
}];
function collectRuntimeConfigAssignments(params) {
	const msteams = getChannelRecord(params.config, "msteams");
	if (!msteams) return;
	collectSecretInputAssignment({
		value: msteams.appPassword,
		path: "channels.msteams.appPassword",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: msteams.enabled !== false,
		inactiveReason: "Microsoft Teams channel is disabled.",
		apply: (value) => {
			msteams.appPassword = value;
		}
	});
}
const channelSecrets = {
	secretTargetRegistryEntries,
	collectRuntimeConfigAssignments
};
//#endregion
export { collectRuntimeConfigAssignments as n, secretTargetRegistryEntries as r, channelSecrets as t };
