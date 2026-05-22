import "./thread-bindings-policy-Btk9SdbL.js";
import "./session-binding-service-Bizp3BT1.js";
import "./conversation-binding-DiTPk5f4.js";
import "./binding-registry-BKIo1lBS.js";
import "./session-BApTLYog.js";
import "./pairing-store-OcLE1qWa.js";
import "./channel-access-compat-BDoiceW7.js";
import "./binding-targets-B0-ellOF.js";
import "./binding-routing-CjqhMSfD.js";
import "./pairing-labels-DCZQBmbp.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-5o9TjWKR.js");
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
