import "./thread-bindings-policy-p0BZRyGm.js";
import "./session-binding-service-DEEot9LS.js";
import "./conversation-binding-DEm4OU0D.js";
import "./binding-registry-CXve8e6m.js";
import "./session-DpbWgUCs.js";
import "./pairing-store-DfXJxuDi.js";
import "./channel-access-compat-Boj7vJNT.js";
import "./binding-targets-Dz5KZzGI.js";
import "./binding-routing-BSnUGz7y.js";
import "./pairing-labels-Dd8f-WG4.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-BFajQL7c.js");
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
