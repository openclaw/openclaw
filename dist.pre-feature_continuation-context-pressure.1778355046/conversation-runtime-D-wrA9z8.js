import "./thread-bindings-policy-Bc-KW4uH.js";
import "./session-binding-service-DeE8vnff.js";
import "./conversation-binding-IJw-0CEN.js";
import "./binding-registry-Bi0QPXki.js";
import "./session-CeQfn26U.js";
import "./pairing-store-DM-cQi74.js";
import "./dm-policy-shared-CFD2FPpz.js";
import "./binding-targets-DWw5kz5c.js";
import "./binding-routing-BApPVRE1.js";
import "./pairing-labels-C5s4xxIn.js";
//#region src/channels/session-meta.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-Cr02Gyj2.js");
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
