import { om as recordSessionMetaFromInbound } from "./auth-profiles-DqxBs6Au.js";
import { l as resolveStorePath } from "./paths-YN5WLIkL.js";
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
