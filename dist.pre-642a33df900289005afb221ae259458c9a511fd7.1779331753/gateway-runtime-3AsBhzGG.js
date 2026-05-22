import "./net-DCUMtgJy.js";
import "./auth-BhFVnN3l.js";
import "./client-DZyo5GYo.js";
import "./protocol-BjJyumEt.js";
import "./operator-approvals-client-HJoozlvH.js";
import "./gateway-rpc-DA1YJog1.js";
import "./hosted-plugin-surface-url-52L_Bva6.js";
import "./node-command-policy-CpHoJmrL.js";
import "./nodes.helpers-DGhrF-u9.js";
import "./startup-auth-Cam1qK_1.js";
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
