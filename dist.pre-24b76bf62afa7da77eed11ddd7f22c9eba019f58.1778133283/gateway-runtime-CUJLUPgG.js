import "./net-CEscmVCn.js";
import "./auth-CGBBnjxU.js";
import "./client-Ifv5IktW.js";
import "./protocol-DZStUQT_.js";
import "./operator-approvals-client-Bq_NGMuI.js";
import "./gateway-rpc-B8OS1eQM.js";
import "./node-command-policy-6QubNE52.js";
import "./nodes.helpers-CWdxEAhD.js";
import "./startup-auth-C8Llqi28.js";
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
