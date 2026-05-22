import "./net-CQP-kC3g.js";
import "./auth-DDj6lESn.js";
import "./client-BwIz3SA1.js";
import "./protocol-CopRe_fC.js";
import "./operator-approvals-client-Dl2rdjQc.js";
import "./gateway-rpc-DQ-eg3tZ.js";
import "./hosted-plugin-surface-url-DUxGREzM.js";
import "./node-command-policy-D7olCQ_J.js";
import "./nodes.helpers-CVwktxq2.js";
import "./startup-auth-bp9IJyWA.js";
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
