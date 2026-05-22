import "./thread-bindings-policy-lpM2XruD.js";
import "./session-binding-service-BW6zmmDL.js";
import "./conversation-binding-CB8PMOd0.js";
import "./binding-registry-C9GhUwct.js";
import "./session-Sgsz9nZ8.js";
import "./pairing-store-lJ0onwbJ.js";
import "./channel-access-compat-DvdXiVL4.js";
import "./binding-targets-BsLV1Miz.js";
import "./binding-routing-LmU8nzVu.js";
import "./pairing-labels-CKOAc5FQ.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-guzw3O6M.js");
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
