import "./safe-text-CZdXrCEj.js";
import { l as chunkTextByBreakResolver } from "./chunk-B9TeD1Cb.js";
import "./tables-CZIqZVR8.js";
import "./chunk-items-Ct6mnMEP.js";
import "./auto-linked-file-ref-DEqRD8RY.js";
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
