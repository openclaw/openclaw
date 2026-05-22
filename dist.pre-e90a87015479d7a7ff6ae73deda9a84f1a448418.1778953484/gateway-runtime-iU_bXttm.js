import "./net-BYZmrkLW.js";
import "./auth-7jrTF66B.js";
import "./client-BHBwW5N5.js";
import "./protocol-DFiQ7lBV.js";
import "./operator-approvals-client-DQ8naGHv.js";
import "./gateway-rpc-BRjSxQKo.js";
import "./hosted-plugin-surface-url-Bt_qc6Jo.js";
import "./node-command-policy-C5_-RV_x.js";
import "./nodes.helpers-CVRAkuyy.js";
import "./startup-auth-BIDLM_bi.js";
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
