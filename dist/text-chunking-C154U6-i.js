import "./safe-text-J_0sTthZ.js";
import { l as chunkTextByBreakResolver } from "./chunk-IIklKK4Y.js";
import "./tables-D3y68tNR.js";
import "./chunk-items-4pJLz72Q.js";
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
