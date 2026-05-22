import "./net-BA-PIAub.js";
import "./auth-C_D-Efrd.js";
import "./client-XP7CTBMn.js";
import "./protocol-Bj4aFpjA.js";
import "./operator-approvals-client-Cg7K9UZQ.js";
import "./gateway-rpc-Cro_f7bL.js";
import "./node-command-policy-CkIP_Ndb.js";
import "./nodes.helpers-BFwQHESd.js";
import "./startup-auth-B53f4e4r.js";
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
