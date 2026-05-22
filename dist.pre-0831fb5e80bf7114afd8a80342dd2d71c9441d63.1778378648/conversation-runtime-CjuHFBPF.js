import "./thread-bindings-policy-bWSOYtb1.js";
import "./session-binding-service-mvdq1kQg.js";
import "./conversation-binding-BC3vx4Gt.js";
import "./binding-registry-DwH9KHSO.js";
import "./session-BZmd5TZI.js";
import "./pairing-store-BPeRu37Y.js";
import "./dm-policy-shared-BZ2cXOUe.js";
import "./binding-targets-Clo-KGsO.js";
import "./binding-routing-BHWNPd4j.js";
import "./pairing-labels-C0INFDZG.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-DucKqBvA.js");
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
