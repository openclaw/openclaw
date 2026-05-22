import "./thread-bindings-policy-BQRka0AJ.js";
import "./session-binding-service-D-U6GzJY.js";
import "./conversation-binding-CrpkxJ_h.js";
import "./binding-registry-CqWn3po0.js";
import "./session-BX2Kimbk.js";
import "./pairing-store-BqPBL6eM.js";
import "./channel-access-compat-CkENi5AT.js";
import "./binding-targets-3haF-aEn.js";
import "./binding-routing-CXu6O_f4.js";
import "./pairing-labels-EGN3GIMn.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-BcRE81ku.js");
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
