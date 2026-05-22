import "./net-DCUMtgJy.js";
import "./auth-DDt3-ZGk.js";
import "./client-CyllBnBi.js";
import "./protocol-Cep1UV7i.js";
import "./operator-approvals-client-Cu-kpvf2.js";
import "./gateway-rpc-DEOq_9FV.js";
import "./hosted-plugin-surface-url-52L_Bva6.js";
import "./node-command-policy-CHy6ugfg.js";
import "./nodes.helpers-CsONYDOI.js";
import "./startup-auth-DXGg0hW5.js";
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
