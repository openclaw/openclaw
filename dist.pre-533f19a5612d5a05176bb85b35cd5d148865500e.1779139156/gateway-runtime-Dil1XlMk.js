import "./net-CQP-kC3g.js";
import "./auth-0uXHmmHu.js";
import "./client-D80gnOaX.js";
import "./protocol-Crpoog51.js";
import "./operator-approvals-client-BNsafvgH.js";
import "./gateway-rpc-CpM3JEv9.js";
import "./hosted-plugin-surface-url-B4F9U6Uj.js";
import "./node-command-policy-BN4DuAGN.js";
import "./nodes.helpers-CJeNsxaJ.js";
import "./startup-auth-B2ia0eod.js";
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
