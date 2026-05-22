import "./safe-text-CZdXrCEj.js";
import { l as chunkTextByBreakResolver } from "./chunk-o-kwX4lv.js";
import "./tables-Byxyxijp.js";
import "./chunk-items-C1frgfxA.js";
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
