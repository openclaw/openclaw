import "./net-DW8WQG5I.js";
import "./auth-D9txGPY0.js";
import "./client-CjEdfzIt.js";
import "./protocol-DWyq7dPP.js";
import "./operator-approvals-client-fxiJSo1B.js";
import "./gateway-rpc-BBWYVUtt.js";
import "./hosted-plugin-surface-url-RpN4NNVJ.js";
import "./node-command-policy-BiMYn2y6.js";
import "./nodes.helpers-COS7uhlQ.js";
import "./startup-auth-BbUem3cz.js";
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
