import "./net-CQP-kC3g.js";
import "./auth-0uXHmmHu.js";
import "./client-D80gnOaX.js";
import "./protocol-Crpoog51.js";
import "./operator-approvals-client-B8yNkNnx.js";
import "./gateway-rpc-eOSGIGg1.js";
import "./hosted-plugin-surface-url-D-3IjMqn.js";
import "./node-command-policy-QnQo9lR-.js";
import "./nodes.helpers-OBsKmm21.js";
import "./startup-auth-DpdpJkTF.js";
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
