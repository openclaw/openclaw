import "./thread-bindings-policy-C9NomKZ1.js";
import "./session-binding-service-DbtznpcX.js";
import "./conversation-binding-a7kRRVeZ.js";
import "./binding-registry-BHQ3KqNE.js";
import "./session-5jiD0wgI.js";
import "./pairing-store-ByMBIIbk.js";
import "./channel-access-compat-CcRkK0fg.js";
import "./binding-targets-B7yL0HVu.js";
import "./binding-routing-DMCQPm5j.js";
import "./pairing-labels-CBI_up0Z.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-7tYK1ih3.js");
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
