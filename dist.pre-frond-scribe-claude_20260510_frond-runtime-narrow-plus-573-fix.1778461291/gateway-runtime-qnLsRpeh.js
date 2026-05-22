import "./net-I-1keREy.js";
import "./auth-ChovBn2k.js";
import "./client-DQrVhwKM.js";
import "./protocol-BZ5ZNWBJ.js";
import "./operator-approvals-client-Cwaba1Ei.js";
import "./gateway-rpc-BYjK4hTX.js";
import "./hosted-plugin-surface-url-B8nJQKrj.js";
import "./node-command-policy-CQMK8xKa.js";
import "./nodes.helpers-CLDPuvAD.js";
import "./startup-auth-BnZDC0bE.js";
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
