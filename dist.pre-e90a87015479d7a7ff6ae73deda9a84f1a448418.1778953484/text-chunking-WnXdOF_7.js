import "./safe-text-BU-8vtYI.js";
import { l as chunkTextByBreakResolver } from "./chunk-DZwoFz2Z.js";
import "./tables-CzgBcTks.js";
import "./chunk-items-BVYp0paL.js";
import "./auto-linked-file-ref-CJTlN4T8.js";
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
