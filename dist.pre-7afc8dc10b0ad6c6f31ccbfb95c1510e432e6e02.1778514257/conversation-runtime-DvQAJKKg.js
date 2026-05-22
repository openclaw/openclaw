import "./thread-bindings-policy-BUD1z2SY.js";
import "./session-binding-service-CyFutUow.js";
import "./conversation-binding-42B8Jzsr.js";
import "./binding-registry-CEYfgJ5e.js";
import "./session-B1dzm1Dk.js";
import "./pairing-store-hjG6lYPV.js";
import "./channel-access-compat-XzJRw0XU.js";
import "./binding-targets-DU2Oh3JU.js";
import "./binding-routing-0fYCAXET.js";
import "./pairing-labels-zkfrRfKP.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-C2-WIPBc.js");
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
