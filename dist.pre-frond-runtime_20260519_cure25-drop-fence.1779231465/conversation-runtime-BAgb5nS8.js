import "./thread-bindings-policy-Btk9SdbL.js";
import "./session-binding-service-t_H1eP6M.js";
import "./conversation-binding-DuoMAjVy.js";
import "./binding-registry-BD_LTGic.js";
import "./session-D7dh-kcF.js";
import "./pairing-store-CNRHI_kn.js";
import "./channel-access-compat-ioVKsLcx.js";
import "./binding-targets-CE_A2si8.js";
import "./binding-routing-Bd9owwwR.js";
import "./pairing-labels-B91aJ_VS.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-D2A_t_yl.js");
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
