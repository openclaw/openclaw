import "./net-xqHkLqZe.js";
import "./auth-Df9rmkQ_.js";
import "./client-ChNcX7-h.js";
import "./protocol-Coga23eo.js";
import "./operator-approvals-client-Bi4X9MXq.js";
import "./gateway-rpc-DdS1I84a.js";
import "./node-command-policy-B3jXEXdg.js";
import "./nodes.helpers-Dp37YJpB.js";
import "./startup-auth-BG2WDEFp.js";
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
