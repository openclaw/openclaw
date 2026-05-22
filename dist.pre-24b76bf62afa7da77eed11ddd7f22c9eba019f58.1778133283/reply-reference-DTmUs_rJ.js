import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/auto-reply/reply/reply-reference.ts
function isSingleUseReplyToMode(mode) {
	return mode === "first" || mode === "batched";
}
function createReplyReferencePlanner(options) {
	let hasReplied = options.hasReplied ?? false;
	const allowReference = options.allowReference !== false;
	const existingId = normalizeOptionalString(options.existingId);
	const startId = normalizeOptionalString(options.startId);
	const resolve = () => {
		if (!allowReference) return;
		if (options.replyToMode === "off") return;
		const id = existingId ?? startId;
		if (!id) return;
		if (options.replyToMode === "all") return id;
		if (isSingleUseReplyToMode(options.replyToMode) && hasReplied) return;
		return id;
	};
	const use = () => {
		const id = resolve();
		if (!id) return;
		hasReplied = true;
		return id;
	};
	const markSent = () => {
		hasReplied = true;
	};
	return {
		peek: resolve,
		use,
		markSent,
		hasReplied: () => hasReplied
	};
}
//#endregion
export { isSingleUseReplyToMode as n, createReplyReferencePlanner as t };
