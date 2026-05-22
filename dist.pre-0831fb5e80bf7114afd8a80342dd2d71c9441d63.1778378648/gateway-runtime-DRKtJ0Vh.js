import "./net-I-1keREy.js";
import "./auth-ChovBn2k.js";
import "./client-C0Fm1GXS.js";
import "./protocol-CAWpVK5t.js";
import "./operator-approvals-client-BuvA9obS.js";
import "./gateway-rpc-DIvOCfFT.js";
import "./hosted-plugin-surface-url-CMwnaKf1.js";
import "./node-command-policy-BYWmDocl.js";
import "./nodes.helpers-CK0kJ4wX.js";
import "./startup-auth-CKqF2GRY.js";
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
