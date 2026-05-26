import "./net-DCUMtgJy.js";
import "./auth-DZ1o6pTQ.js";
import "./client-B1EH_7Mz.js";
import "./protocol-DiXjp30g.js";
import "./operator-approvals-client-Dby3RB4d.js";
import "./gateway-rpc-COT1oBPJ.js";
import "./hosted-plugin-surface-url-52L_Bva6.js";
import "./node-command-policy-Bsyvfkrl.js";
import "./nodes.helpers-DvsMU-XC.js";
import "./startup-auth-CWNnB8iD.js";
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
