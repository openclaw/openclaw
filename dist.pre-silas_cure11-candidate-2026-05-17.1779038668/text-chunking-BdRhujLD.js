import "./safe-text-C1oixi3E.js";
import { l as chunkTextByBreakResolver } from "./chunk-BkjHRVGW.js";
import "./tables-CAZXQvLE.js";
import "./chunk-items-BD63a_k_.js";
import "./auto-linked-file-ref-CyB-Nlhp.js";
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
