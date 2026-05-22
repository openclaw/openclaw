import "./net-Dpr-pD-p.js";
import "./auth-C7c9beQI.js";
import "./client-DotWM0a7.js";
import "./protocol-C4iANhUL.js";
import "./operator-approvals-client-DtATqM-Y.js";
import "./gateway-rpc-Bil3x9dn.js";
import "./hosted-plugin-surface-url-DxeNtEu5.js";
import "./node-command-policy-B0mSkL25.js";
import "./nodes.helpers-Cn4RvS7e.js";
import "./startup-auth-B8ERdD02.js";
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
