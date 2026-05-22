import "./thread-bindings-policy-DRjtd6Gy.js";
import "./session-binding-service-it9hP765.js";
import "./conversation-binding-BqjFT24B.js";
import "./binding-registry-DxiZaYpf.js";
import "./session-Css3Ez_s.js";
import "./pairing-store-Dp1XQCZ_.js";
import "./dm-policy-shared-DkWXKZ4l.js";
import "./binding-targets-xnjKYfS-.js";
import "./binding-routing-CRe6Jnrg.js";
import "./pairing-labels-DADpohn3.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-B8M9TPex.js");
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
