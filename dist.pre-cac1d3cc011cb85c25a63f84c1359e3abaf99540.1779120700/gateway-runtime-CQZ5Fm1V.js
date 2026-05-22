import "./net-CQP-kC3g.js";
import "./auth-DDj6lESn.js";
import "./client-CbHVmPP8.js";
import "./protocol-CopRe_fC.js";
import "./operator-approvals-client-DgEBN9nb.js";
import "./gateway-rpc-BtnMJqDq.js";
import "./hosted-plugin-surface-url-D7lmLrvA.js";
import "./node-command-policy-BjJnTzWE.js";
import "./nodes.helpers-BXt7Av-g.js";
import "./startup-auth-BegTIM_8.js";
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
