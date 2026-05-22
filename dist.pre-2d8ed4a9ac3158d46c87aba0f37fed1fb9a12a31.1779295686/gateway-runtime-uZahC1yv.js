import "./net-CQP-kC3g.js";
import "./auth-0uXHmmHu.js";
import "./client-D80gnOaX.js";
import "./protocol-Crpoog51.js";
import "./operator-approvals-client-czwSY4OF.js";
import "./gateway-rpc-DofPXr-8.js";
import "./hosted-plugin-surface-url-BfU3Gk-W.js";
import "./node-command-policy-DzedcYQ-.js";
import "./nodes.helpers-BEC3tBsX.js";
import "./startup-auth-Vk2ybLCx.js";
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
