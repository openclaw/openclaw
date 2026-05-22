//#region src/channels/command-gating.ts
function resolveCommandAuthorizedFromAuthorizers(params) {
	const { useAccessGroups, authorizers } = params;
	const mode = params.modeWhenAccessGroupsOff ?? "allow";
	if (!useAccessGroups) {
		if (mode === "allow") return true;
		if (mode === "deny") return false;
		if (!authorizers.some((entry) => entry.configured)) return true;
		return authorizers.some((entry) => entry.configured && entry.allowed);
	}
	return authorizers.some((entry) => entry.configured && entry.allowed);
}
function resolveControlCommandGate(params) {
	const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups: params.useAccessGroups,
		authorizers: params.authorizers,
		modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff
	});
	return {
		commandAuthorized,
		shouldBlock: params.allowTextCommands && params.hasControlCommand && !commandAuthorized
	};
}
function resolveDualTextControlCommandGate(params) {
	return resolveControlCommandGate({
		useAccessGroups: params.useAccessGroups,
		authorizers: [{
			configured: params.primaryConfigured,
			allowed: params.primaryAllowed
		}, {
			configured: params.secondaryConfigured,
			allowed: params.secondaryAllowed
		}],
		allowTextCommands: true,
		hasControlCommand: params.hasControlCommand,
		modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff
	});
}
//#endregion
export { resolveControlCommandGate as n, resolveDualTextControlCommandGate as r, resolveCommandAuthorizedFromAuthorizers as t };
