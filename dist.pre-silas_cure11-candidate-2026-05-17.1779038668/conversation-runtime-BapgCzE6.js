import "./thread-bindings-policy-Bln1BF0M.js";
import "./session-binding-service-oz0360ya.js";
import "./conversation-binding-DBGrpEYV.js";
import "./binding-registry-O_S-2m9o.js";
import "./session-DmUPGn_F.js";
import "./pairing-store-CEZUwm53.js";
import "./channel-access-compat-BNa6PFRV.js";
import "./binding-targets-B_JD76oq.js";
import "./binding-routing-CReOfbTf.js";
import "./pairing-labels-Cb_1u8Bo.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-Dzn5NVKa.js");
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
