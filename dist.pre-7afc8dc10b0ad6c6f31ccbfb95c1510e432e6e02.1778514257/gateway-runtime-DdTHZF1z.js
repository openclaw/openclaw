import "./net-I-1keREy.js";
import "./auth-xLrfMZQL.js";
import "./client-DjX0wpWA.js";
import "./protocol-BLKEhqRU.js";
import "./operator-approvals-client-B0UPD5Lo.js";
import "./gateway-rpc-DeT1gsUn.js";
import "./hosted-plugin-surface-url-w8hHXwvM.js";
import "./node-command-policy-DFeHw6gS.js";
import "./nodes.helpers-CP48t-wS.js";
import "./startup-auth-X6srT-EA.js";
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
