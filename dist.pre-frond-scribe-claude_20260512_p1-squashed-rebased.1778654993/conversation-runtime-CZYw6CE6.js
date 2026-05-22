import "./thread-bindings-policy-CTmveUgN.js";
import "./session-binding-service-DGeCl3cy.js";
import "./conversation-binding-DB5GLJpE.js";
import "./binding-registry-D5MRFtW2.js";
import "./session-CRcoQBFH.js";
import "./pairing-store-qjmvsU_d.js";
import "./channel-access-compat-DXrBpM5f.js";
import "./binding-targets-BK0d85v2.js";
import "./binding-routing-gH_TCQDl.js";
import "./pairing-labels-BbGdukt4.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-CxD1dTl6.js");
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
