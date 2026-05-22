import "./thread-bindings-policy-BAPxmvid.js";
import "./session-binding-service-BQX0752D.js";
import "./conversation-binding-BTTgr4_b.js";
import "./binding-registry-DP42WadZ.js";
import "./session-C-rxL5VH.js";
import "./pairing-store-MJ3oSu7K.js";
import "./channel-access-compat-KzZ0PrVh.js";
import "./binding-targets-HGQOz6PE.js";
import "./binding-routing-DokpSX5C.js";
import "./pairing-labels-C-u-8Ndn.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-YQqXzW8a.js");
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
