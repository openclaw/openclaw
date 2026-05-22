import "./thread-bindings-policy-v3JwumhN.js";
import "./session-binding-service-D-_7SRXx.js";
import "./conversation-binding-B_FhMTfI.js";
import "./binding-registry-DhO1w5s0.js";
import "./session-BdBKl4mH.js";
import "./pairing-store-DJHIOiD3.js";
import "./dm-policy-shared-CLOIwDKb.js";
import "./binding-targets-Ba8prKlL.js";
import "./binding-routing-DcKz5Pk9.js";
import "./pairing-labels-EsnYW5Yd.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-BQfQGK6-.js");
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
