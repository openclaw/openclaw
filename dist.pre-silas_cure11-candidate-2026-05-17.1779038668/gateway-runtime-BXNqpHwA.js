import "./net-DW8WQG5I.js";
import "./auth-D9txGPY0.js";
import "./client-yvDogEs5.js";
import "./protocol-B19qkHL1.js";
import "./operator-approvals-client-CvH88B5r.js";
import "./gateway-rpc-C1oUO-FE.js";
import "./hosted-plugin-surface-url-mEzWhgD4.js";
import "./node-command-policy-arujM8Bg.js";
import "./nodes.helpers-uYaLkesO.js";
import "./startup-auth-BRwRHBUS.js";
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
