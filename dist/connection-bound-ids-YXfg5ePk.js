import { createHash } from "node:crypto";
//#region extensions/github-copilot/connection-bound-ids.ts
function looksLikeConnectionBoundId(id) {
	if (id.length < 24) return false;
	if (/^(?:rs|msg|fc)_[A-Za-z0-9_-]+$/.test(id)) return false;
	if (!/^[A-Za-z0-9+/_-]+=*$/.test(id)) return false;
	return Buffer.from(id, "base64").length >= 16;
}
function deriveReplacementId(type, originalId) {
	return `${type === "function_call" ? "fc" : "msg"}_${createHash("sha256").update(originalId).digest("hex").slice(0, 16)}`;
}
function isInputItem(value) {
	return !!value && typeof value === "object";
}
function isValidReasoningReplayId(id) {
	return typeof id === "string" && id.length > 0 && id.length <= 64;
}
function sanitizeCopilotReplayResponseIds(input) {
	if (!Array.isArray(input)) return false;
	let rewrote = false;
	for (let index = input.length - 1; index >= 0; index -= 1) {
		const item = input[index];
		if (!isInputItem(item)) continue;
		const id = item.id;
		if (item.type === "reasoning") {
			if (!isValidReasoningReplayId(id)) {
				input.splice(index, 1);
				rewrote = true;
			}
			continue;
		}
		if (typeof id !== "string" || id.length === 0) continue;
		if (looksLikeConnectionBoundId(id)) {
			item.id = deriveReplacementId(typeof item.type === "string" ? item.type : void 0, id);
			rewrote = true;
		}
	}
	return rewrote;
}
function rewriteCopilotConnectionBoundResponseIds(input) {
	return sanitizeCopilotReplayResponseIds(input);
}
function sanitizeCopilotReplayResponsePayloadIds(payload) {
	if (!payload || typeof payload !== "object") return false;
	return sanitizeCopilotReplayResponseIds(payload.input);
}
function rewriteCopilotResponsePayloadConnectionBoundIds(payload) {
	return sanitizeCopilotReplayResponsePayloadIds(payload);
}
//#endregion
export { sanitizeCopilotReplayResponsePayloadIds as i, rewriteCopilotResponsePayloadConnectionBoundIds as n, sanitizeCopilotReplayResponseIds as r, rewriteCopilotConnectionBoundResponseIds as t };
