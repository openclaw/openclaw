import "./thread-bindings-policy-Okf0AVy2.js";
import "./session-binding-service-D0ydi7vt.js";
import "./conversation-binding-DOUfFa-1.js";
import "./binding-registry-BHmUix_L.js";
import "./session-_h0szTwc.js";
import "./pairing-store-CKKT3U6f.js";
import "./channel-access-compat-CxLuLEz_.js";
import "./binding-targets-Diys0pdO.js";
import "./binding-routing-rFwNGcny.js";
import "./pairing-labels-DOz2T3Nw.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-BRoizwAA.js");
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
