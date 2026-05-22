import "./safe-text-J_0sTthZ.js";
import { l as chunkTextByBreakResolver } from "./chunk-BUVFtz91.js";
import "./tables-DjduJfoF.js";
import "./chunk-items-DjwYfVN5.js";
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
