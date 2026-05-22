import "./thread-bindings-policy-CDMfe5qT.js";
import "./pairing-store-D_Q2ijwq.js";
import "./session-binding-service-Brz3TVSF.js";
import "./conversation-binding-BLbJnl4_.js";
import "./binding-registry-BGVxfVTJ.js";
import "./session-COU0hyU_.js";
import "./channel-access-compat-BSxmz7_J.js";
import "./binding-targets-DCqO8qxz.js";
import "./binding-routing-D3uydaVM.js";
import "./pairing-labels-6CQsxdJO.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-ChRHamL8.js");
	return inboundSessionRuntimePromise;
}
async function recordInboundSessionMetaSafe(params) {
	const runtime = await loadInboundSessionRuntime();
	const storePath = runtime.resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
	try {
		await runtime.recordSessionMetaFromInbound({
			storePath,
			sessionKey: params.sessionKey,
			ctx: params.ctx
		});
	} catch (err) {
		params.onError?.(err);
	}
}
//#endregion
export { recordInboundSessionMetaSafe as t };
