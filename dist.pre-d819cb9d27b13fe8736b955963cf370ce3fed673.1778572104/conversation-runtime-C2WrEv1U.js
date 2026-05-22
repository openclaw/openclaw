import "./thread-bindings-policy-BxTU1eJK.js";
import "./session-binding-service-D0ydi7vt.js";
import "./conversation-binding-CybTanxc.js";
import "./binding-registry-Cm7hLKYn.js";
import "./session-wVd8d2m3.js";
import "./pairing-store-Ck_jPbH4.js";
import "./channel-access-compat-CramsYVg.js";
import "./binding-targets-CFy85uCa.js";
import "./binding-routing-Dd8YbriB.js";
import "./pairing-labels-9tlJxPoW.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-wdIg4Otc.js");
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
