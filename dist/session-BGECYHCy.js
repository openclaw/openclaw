import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
//#region src/channels/session.ts
let inboundSessionRuntimePromise = null;
function loadInboundSessionRuntime() {
	inboundSessionRuntimePromise ??= import("./inbound.runtime-DHnpDBw8.js");
	return inboundSessionRuntimePromise;
}
function shouldSkipPinnedMainDmRouteUpdate(pin) {
	if (!pin) return false;
	const owner = normalizeLowercaseStringOrEmpty(pin.ownerRecipient);
	const sender = normalizeLowercaseStringOrEmpty(pin.senderRecipient);
	if (!owner || !sender || owner === sender) return false;
	pin.onSkip?.({
		ownerRecipient: pin.ownerRecipient,
		senderRecipient: pin.senderRecipient
	});
	return true;
}
async function recordInboundSession(params) {
	const { storePath, sessionKey, ctx, groupResolution, createIfMissing } = params;
	const canonicalSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
	const runtime = await loadInboundSessionRuntime();
	const metaTask = runtime.recordSessionMetaFromInbound({
		storePath,
		sessionKey: canonicalSessionKey,
		ctx,
		groupResolution,
		createIfMissing
	}).catch(params.onRecordError);
	params.trackSessionMetaTask?.(metaTask);
	const update = params.updateLastRoute;
	if (!update) return;
	if (shouldSkipPinnedMainDmRouteUpdate(update.mainDmOwnerPin)) return;
	const targetSessionKey = normalizeLowercaseStringOrEmpty(update.sessionKey);
	await runtime.updateLastRoute({
		storePath,
		sessionKey: targetSessionKey,
		deliveryContext: {
			channel: update.channel,
			to: update.to,
			accountId: update.accountId,
			threadId: update.threadId
		},
		ctx: targetSessionKey === canonicalSessionKey ? ctx : void 0,
		groupResolution,
		createIfMissing
	});
}
//#endregion
export { recordInboundSession as t };
