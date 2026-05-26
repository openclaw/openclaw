import "./session-binding-service-C69Hco9-.js";
import "./thread-bindings-policy-CfNtBxKV.js";
import "./conversation-binding-mt8hjpt4.js";
import "./binding-registry-CljyPxAO.js";
import "./session-BGECYHCy.js";
import "./pairing-store-DKcswb9w.js";
import "./channel-access-compat-Dny0RAlV.js";
import "./binding-targets-BYGKQ_Nm.js";
import "./binding-routing-LTxSqa_y.js";
import "./pairing-labels-DI4va5V2.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-DHnpDBw8.js");
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
