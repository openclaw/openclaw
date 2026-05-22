import "./thread-bindings-policy-BIa01M5B.js";
import "./session-binding-service-D1jVcQu7.js";
import "./binding-registry-4-JwCwug.js";
import "./conversation-binding-CjlwR36l.js";
import "./session-DiXXaF8K.js";
import "./pairing-store-DFgmKCqc.js";
import "./dm-policy-shared-CCy2a_KA.js";
import "./binding-targets-Ml6sxjdx.js";
import "./binding-routing-DcLbACha.js";
import "./pairing-labels-BH62AJIy.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-Dh69JKUM.js");
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
