import { Ns as recordSessionMetaFromInbound } from "./setup-wizard-helpers-BPw-E_P4.js";
import { R as resolveStorePath } from "./query-expansion-t4qzEE5Z.js";
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
