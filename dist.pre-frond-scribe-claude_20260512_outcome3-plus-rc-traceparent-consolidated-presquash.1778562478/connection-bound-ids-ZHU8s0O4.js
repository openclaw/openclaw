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
function rewriteCopilotConnectionBoundResponseIds(input) {
	if (!Array.isArray(input)) return false;
	let rewrote = false;
	for (const item of input) {
		const id = item.id;
		if (typeof id !== "string" || id.length === 0) continue;
		if (item.type === "reasoning") continue;
		if (looksLikeConnectionBoundId(id)) {
			item.id = deriveReplacementId(typeof item.type === "string" ? item.type : void 0, id);
			rewrote = true;
		}
	}
	return rewrote;
}
function rewriteCopilotResponsePayloadConnectionBoundIds(payload) {
	if (!payload || typeof payload !== "object") return false;
	return rewriteCopilotConnectionBoundResponseIds(payload.input);
}
//#endregion
export { rewriteCopilotResponsePayloadConnectionBoundIds as n, rewriteCopilotConnectionBoundResponseIds as t };
