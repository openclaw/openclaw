import "./thread-bindings-policy-F89cN-SM.js";
import "./session-binding-service-CBilRC4a.js";
import "./conversation-binding-DNI48eWf.js";
import "./binding-registry-fmrdWrOC.js";
import "./session-BvV3XuPa.js";
import "./pairing-store-DrDu25eS.js";
import "./channel-access-compat-bV_pcr0z.js";
import "./binding-targets-D5mBJved.js";
import "./binding-routing-M4unkRTm.js";
import "./pairing-labels-D4wERf1n.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-BmOVX-X0.js");
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
