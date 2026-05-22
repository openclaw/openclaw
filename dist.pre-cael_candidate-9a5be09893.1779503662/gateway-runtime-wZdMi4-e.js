import "./net-DCUMtgJy.js";
import "./auth-CCZTHYGp.js";
import "./client-B-RAcLvm.js";
import "./protocol-DOSi8QvH.js";
import "./operator-approvals-client-C9ehOSI5.js";
import "./gateway-rpc-d-Le_fvC.js";
import "./hosted-plugin-surface-url-52L_Bva6.js";
import "./node-command-policy-BA-gqDOl.js";
import "./nodes.helpers-BrgkX7RP.js";
import "./startup-auth-CVcWHmuJ.js";
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
