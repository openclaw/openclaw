import "./thread-bindings-policy-BXjVg4Jy.js";
import "./session-binding-service-DdD-jlMI.js";
import "./conversation-binding-D69JuPq2.js";
import "./binding-registry-CvbqaAcG.js";
import "./session-BK_u55Mv.js";
import "./pairing-store-B07-m5O1.js";
import "./dm-policy-shared-WPgrRbHo.js";
import "./binding-targets-B-yu6EAJ.js";
import "./binding-routing-BSsRjIJE.js";
import "./pairing-labels-CpZTcBu2.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-Co6S176k.js");
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
