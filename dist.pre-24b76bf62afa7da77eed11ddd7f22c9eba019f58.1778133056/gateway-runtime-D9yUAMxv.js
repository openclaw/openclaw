import "./net-BMdoYZVC.js";
import "./auth-BB3qW0jS.js";
import "./client-4JCE10kG.js";
import "./protocol-I0uBH5gX.js";
import "./operator-approvals-client-BnTU7OII.js";
import "./gateway-rpc-KCd1AHB8.js";
import "./node-command-policy-ClfqNRjF.js";
import "./nodes.helpers-Bc36PI4_.js";
import "./startup-auth-C8nSLJz7.js";
//#region src/gateway/channel-status-patches.ts
function createConnectedChannelStatusPatch(at = Date.now()) {
	return {
		connected: true,
		lastConnectedAt: at,
		lastEventAt: at
	};
}
function createTransportActivityStatusPatch(at = Date.now()) {
	return { lastTransportActivityAt: at };
}
//#endregion
export { createTransportActivityStatusPatch as n, createConnectedChannelStatusPatch as t };
