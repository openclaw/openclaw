import "./safe-text-J_0sTthZ.js";
import { l as chunkTextByBreakResolver } from "./chunk-Bb3njsti.js";
import "./tables-BtCSpnMb.js";
import "./chunk-items-Bt68RN3m.js";
import "./auto-linked-file-ref-kqLj-Euu.js";
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
