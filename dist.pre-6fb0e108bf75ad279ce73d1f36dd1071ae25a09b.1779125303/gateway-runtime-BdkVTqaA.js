import "./net-CQP-kC3g.js";
import "./auth-0uXHmmHu.js";
import "./client-gUu4i0xa.js";
import "./protocol-UtR7bV2l.js";
import "./operator-approvals-client-CpHetA8Q.js";
import "./gateway-rpc-CGy29VSd.js";
import "./hosted-plugin-surface-url-Bqvq1TIh.js";
import "./node-command-policy-DXDDO0HJ.js";
import "./nodes.helpers-vo1FCSEs.js";
import "./startup-auth-BQg2zRQe.js";
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
