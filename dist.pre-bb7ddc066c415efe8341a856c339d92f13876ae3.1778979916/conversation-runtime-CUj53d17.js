import "./thread-bindings-policy-CAVkwuEU.js";
import "./session-binding-service-jyTuWwhb.js";
import "./conversation-binding-CsMKs3-s.js";
import "./binding-registry-BnUB3uoe.js";
import "./session-vftCVCgA.js";
import "./pairing-store-zE2KlYxx.js";
import "./channel-access-compat-CbVs_A5Z.js";
import "./binding-targets-B3q7lq0N.js";
import "./binding-routing-Cky_qzAv.js";
import "./pairing-labels-DhOjYNKh.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-KsNGw7VT.js");
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
