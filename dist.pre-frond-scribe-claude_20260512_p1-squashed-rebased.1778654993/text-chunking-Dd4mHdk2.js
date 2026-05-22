import "./safe-text-Dw_rwKEN.js";
import { l as chunkTextByBreakResolver } from "./chunk-CVo5aUOt.js";
import "./tables-o4c5CUUm.js";
import "./chunk-items-Cqw0infI.js";
import "./auto-linked-file-ref-Bp90b61K.js";
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
