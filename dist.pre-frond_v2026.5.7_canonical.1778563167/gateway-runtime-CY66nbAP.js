import "./net-DpXvrs-2.js";
import "./auth-1IV421RZ.js";
import "./client-DnIa9BiZ.js";
import "./protocol-DQhlw1in.js";
import "./operator-approvals-client-BjIlu9zb.js";
import "./gateway-rpc-DitXqTco.js";
import "./hosted-plugin-surface-url-Bk2jD8zA.js";
import "./node-command-policy-B_vsERP7.js";
import "./nodes.helpers-D1Iz6Obo.js";
import "./startup-auth-CLLnMIPg.js";
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
