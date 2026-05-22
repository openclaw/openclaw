import "./thread-bindings-policy-BTolXZ1B.js";
import "./session-binding-service-BLCIEa1x.js";
import "./conversation-binding-BWU5z_Gr.js";
import "./binding-registry-IhURfv3y.js";
import "./session-CDaxTMui.js";
import "./pairing-store-BlGIjT_b.js";
import "./dm-policy-shared-C7MlRVkr.js";
import "./binding-targets-CfX3DKcD.js";
import "./binding-routing-DeIvCySs.js";
import "./pairing-labels-02jQ_4yh.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-IwYr7ekb.js");
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
