import "./safe-text-CdNixupx.js";
import { l as chunkTextByBreakResolver } from "./chunk-CGVwhsnj.js";
import "./tables-Bk81cN4I.js";
import "./chunk-items-D9SIVk6m.js";
import "./auto-linked-file-ref-BdubrmnM.js";
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
