//#region extensions/device-pair/pair-command-auth.ts
function isInternalGatewayPairingCaller(params) {
	return params.channel === "webchat" || Array.isArray(params.gatewayClientScopes);
}
function resolvePairingCommandAuthState(params) {
	const isInternalGatewayCaller = isInternalGatewayPairingCaller(params);
	if (!isInternalGatewayCaller) return {
		isInternalGatewayCaller,
		isMissingInternalPairingPrivilege: false,
		approvalCallerScopes: void 0
	};
	const approvalCallerScopes = Array.isArray(params.gatewayClientScopes) ? params.gatewayClientScopes : [];
	return {
		isInternalGatewayCaller,
		isMissingInternalPairingPrivilege: !approvalCallerScopes.includes("operator.pairing") && !approvalCallerScopes.includes("operator.admin"),
		approvalCallerScopes
	};
}
function buildMissingPairingScopeReply() {
	return { text: "⚠️ This command requires operator.pairing for internal gateway callers." };
}
//#endregion
export { resolvePairingCommandAuthState as n, buildMissingPairingScopeReply as t };
