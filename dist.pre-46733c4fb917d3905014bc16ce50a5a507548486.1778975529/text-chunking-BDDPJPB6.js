import "./safe-text-C1oixi3E.js";
import { l as chunkTextByBreakResolver } from "./chunk-CrYIBV5V.js";
import "./tables-BXCAKaIS.js";
import "./chunk-items-BtazOUyB.js";
import "./auto-linked-file-ref-Cel7eNSh.js";
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
