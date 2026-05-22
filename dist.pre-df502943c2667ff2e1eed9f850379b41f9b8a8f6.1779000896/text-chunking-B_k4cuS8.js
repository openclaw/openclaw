import "./safe-text-C1oixi3E.js";
import { l as chunkTextByBreakResolver } from "./chunk-CWxm2ihr.js";
import "./tables-DN7xAqlm.js";
import "./chunk-items-By1Sk-o7.js";
import "./auto-linked-file-ref-DLzrPvmz.js";
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
