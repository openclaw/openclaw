import "./net-Gkm1Cz9b.js";
import "./auth-e6hlqNhL.js";
import "./client-BGs41kAq.js";
import "./protocol-QC2mQFMN.js";
import "./operator-approvals-client-DhuKX2Cs.js";
import "./gateway-rpc-Dfnu29I8.js";
import "./hosted-plugin-surface-url-CwC2jrHk.js";
import "./node-command-policy-rX_utHfg.js";
import "./nodes.helpers-C6DTE9FR.js";
import "./startup-auth-BgvYjwgU.js";
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
