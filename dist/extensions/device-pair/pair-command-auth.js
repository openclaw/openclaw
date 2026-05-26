//#region extensions/device-pair/pair-command-auth.ts
const COMMAND_OWNER_PAIRING_SCOPES = ["operator.pairing"];
function isInternalGatewayPairingCaller(params) {
	return params.channel === "webchat" || Array.isArray(params.gatewayClientScopes);
}
function resolvePairingCommandAuthState(params) {
	const isInternalGatewayCaller = isInternalGatewayPairingCaller(params);
	if (isInternalGatewayCaller) {
		const approvalCallerScopes = Array.isArray(params.gatewayClientScopes) ? params.gatewayClientScopes : [];
		return {
			isInternalGatewayCaller,
			isMissingPairingPrivilege: !approvalCallerScopes.includes("operator.pairing") && !approvalCallerScopes.includes("operator.admin"),
			approvalCallerScopes
		};
	}
	if (params.senderIsOwner === true) return {
		isInternalGatewayCaller,
		isMissingPairingPrivilege: false,
		approvalCallerScopes: COMMAND_OWNER_PAIRING_SCOPES
	};
	return {
		isInternalGatewayCaller,
		isMissingPairingPrivilege: true,
		approvalCallerScopes: void 0
	};
}
function buildMissingPairingScopeReply() {
	return { text: "⚠️ This command requires operator.pairing." };
}
//#endregion
export { buildMissingPairingScopeReply, resolvePairingCommandAuthState };
