import "./thread-bindings-policy-Btk9SdbL.js";
import "./session-binding-service-t_H1eP6M.js";
import "./conversation-binding-Br1dgda2.js";
import "./binding-registry-BXokA1S6.js";
import "./session-D9EXtB5D.js";
import "./pairing-store-Crhg5AIi.js";
import "./channel-access-compat-DCJ1yA4z.js";
import "./binding-targets-BuptzOY2.js";
import "./binding-routing-e83jl3b1.js";
import "./pairing-labels-BD7QcxyK.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-WllguoNX.js");
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
