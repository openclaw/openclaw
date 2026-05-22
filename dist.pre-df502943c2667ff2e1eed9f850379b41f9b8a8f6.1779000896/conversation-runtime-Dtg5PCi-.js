import "./thread-bindings-policy-Bln1BF0M.js";
import "./session-binding-service-3nrPrf0a.js";
import "./conversation-binding-DkcuaEkJ.js";
import "./binding-registry-RlwMYdop.js";
import "./session-DbhZwvHQ.js";
import "./pairing-store-BlILt3B5.js";
import "./channel-access-compat-Bo1e3jNt.js";
import "./binding-targets-D6O2jmn_.js";
import "./binding-routing-ClDNjfVf.js";
import "./pairing-labels-DRhrFW0f.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-CIg2xTZr.js");
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
