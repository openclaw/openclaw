import "./net-DpXvrs-2.js";
import "./auth-DDx57YI1.js";
import "./client-BuyF0OO_.js";
import "./protocol-CF-7GIPV.js";
import "./operator-approvals-client-BxyLI2AB.js";
import "./gateway-rpc-BaKbjMLQ.js";
import "./hosted-plugin-surface-url-Bk2jD8zA.js";
import "./node-command-policy-BhvV3CxH.js";
import "./nodes.helpers-DFP3KqM9.js";
import "./startup-auth-B552el_7.js";
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
