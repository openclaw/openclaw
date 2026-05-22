import "./safe-text-CZdXrCEj.js";
import { l as chunkTextByBreakResolver } from "./chunk-DUB04dEk.js";
import "./tables-DK8Y-WQ-.js";
import "./chunk-items-DNAfHbiZ.js";
import "./auto-linked-file-ref-B2UNWjpz.js";
//#region src/plugin-sdk/text-chunking.ts
/** Chunk outbound text while preferring newline boundaries over spaces. */
function chunkTextForOutbound(text, limit) {
	return chunkTextByBreakResolver(text, limit, (window) => {
		const lastNewline = window.lastIndexOf("\n");
		const lastSpace = window.lastIndexOf(" ");
		return lastNewline > 0 ? lastNewline : lastSpace;
	});
}
//#endregion
export { chunkTextForOutbound as t };
