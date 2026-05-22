import "./thread-bindings-policy-CEtbOvRY.js";
import "./session-binding-service-BCyhY_kj.js";
import "./conversation-binding-BXFt2-Dc.js";
import "./binding-registry-C1_pKa5u.js";
import "./session-DBWpjeG3.js";
import "./pairing-store-DC2bIsF3.js";
import "./channel-access-compat-CZlwBdNX.js";
import "./binding-targets-CtK69Phf.js";
import "./binding-routing-D22-kk_i.js";
import "./pairing-labels-DNEmW4rI.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-_VVDeTQm.js");
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
