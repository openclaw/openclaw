import "./net-CQP-kC3g.js";
import "./auth-0uXHmmHu.js";
import "./client-D80gnOaX.js";
import "./protocol-Crpoog51.js";
import "./operator-approvals-client-DqeoExGC.js";
import "./gateway-rpc-DLER6OT_.js";
import "./hosted-plugin-surface-url-BOab12OW.js";
import "./node-command-policy-Cctll6Ef.js";
import "./nodes.helpers-CagE97t4.js";
import "./startup-auth-CuVujex8.js";
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
