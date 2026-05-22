import "./net-CEscmVCn.js";
import "./auth-ARvHEIK7.js";
import "./client--35_P8ny.js";
import "./protocol-8n012BZA.js";
import "./operator-approvals-client-BAqsGrXh.js";
import "./gateway-rpc-CZmVOdGI.js";
import "./node-command-policy-B1zp9bjl.js";
import "./nodes.helpers-BigKkdm3.js";
import "./startup-auth-DIET1CWc.js";
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
