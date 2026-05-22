import "./net-CLmerLvz.js";
import "./auth-BfKB6uN1.js";
import "./client-b_zkj2Kv.js";
import "./protocol-DZ9c3mr8.js";
import "./operator-approvals-client-CzvSno_y.js";
import "./gateway-rpc-gO9VVKYS.js";
import "./hosted-plugin-surface-url-DTDiJIvO.js";
import "./node-command-policy-BgJ0evRn.js";
import "./nodes.helpers-BLownPB-.js";
import "./startup-auth-u2fQxXIR.js";
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
