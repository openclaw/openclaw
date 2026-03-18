import { R as resolveStorePath } from "./query-expansion-BRXofpTG.js";
import { ko as recordSessionMetaFromInbound } from "./model-selection-DTQXVq3-.js";
//#region src/channels/session-meta.ts
async function recordInboundSessionMetaSafe(params) {
	const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
	try {
		await recordSessionMetaFromInbound({
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
