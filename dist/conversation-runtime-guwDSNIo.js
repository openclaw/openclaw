import "./session-binding-service-B19FMAqz.js";
import "./pairing-store-jPMfFWFn.js";
import "./thread-bindings-policy-BAuuUJk1.js";
import "./conversation-binding-CMioKWCr.js";
import "./binding-registry-dyeOsusx.js";
import "./session-CCAfHrW1.js";
import "./channel-access-compat-EGOB-mde.js";
import "./binding-targets-DimW-OV5.js";
import "./binding-routing-DfoE5KF_.js";
import "./pairing-labels-D7SOe44q.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-Db_bFyRE.js");
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
