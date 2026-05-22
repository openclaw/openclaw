import "./net-CLmerLvz.js";
import "./auth-p1uCwunm.js";
import "./client-DDADSo6k.js";
import "./protocol-8H1JQJ4t.js";
import "./operator-approvals-client-Iqs1A5Db.js";
import "./gateway-rpc-D76C-Ud2.js";
import "./hosted-plugin-surface-url-BbdBv8Rq.js";
import "./node-command-policy-BTXSNvyB.js";
import "./nodes.helpers-LeggKC6R.js";
import "./startup-auth-BBH2Xxkl.js";
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
