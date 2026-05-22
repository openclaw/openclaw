import "./thread-bindings-policy-CAviF5AZ.js";
import "./session-binding-service-DssF7JYi.js";
import "./binding-registry-CbM6IHJs.js";
import "./conversation-binding-Cn476Ys4.js";
import "./session-DsuzeLfr.js";
import "./pairing-store-BI1ByK4W.js";
import "./dm-policy-shared-DAgHnxNz.js";
import "./binding-targets-CDShm3jX.js";
import "./binding-routing-DMtWLatL.js";
import "./pairing-labels-DFm5ezHB.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-BMrf9644.js");
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
