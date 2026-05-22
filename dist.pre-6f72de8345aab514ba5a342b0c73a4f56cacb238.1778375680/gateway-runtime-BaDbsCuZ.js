import "./net-DrO5tffj.js";
import "./auth-BdM_W7Td.js";
import "./client-DaqqkT7C.js";
import "./protocol-B47jtleT.js";
import "./operator-approvals-client-DC4Ed1uM.js";
import "./gateway-rpc-BkVtn5lX.js";
import "./hosted-plugin-surface-url-BFCMBy26.js";
import "./node-command-policy-tEPCl_Dr.js";
import "./nodes.helpers-CtzGuXL_.js";
import "./startup-auth-Ds32z68_.js";
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
