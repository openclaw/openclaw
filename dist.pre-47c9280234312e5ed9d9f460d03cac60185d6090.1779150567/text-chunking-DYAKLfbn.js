import "./safe-text-CZdXrCEj.js";
import { l as chunkTextByBreakResolver } from "./chunk-DUB04dEk.js";
import "./tables-oAhnEQ1H.js";
import "./chunk-items-DdjdEkTm.js";
import "./auto-linked-file-ref-Cv41idc1.js";
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
