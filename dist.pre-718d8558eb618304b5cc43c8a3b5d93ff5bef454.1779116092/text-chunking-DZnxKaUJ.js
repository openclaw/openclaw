import "./safe-text-CZdXrCEj.js";
import { l as chunkTextByBreakResolver } from "./chunk-ekIU3ke9.js";
import "./tables-bX-XBBbC.js";
import "./chunk-items-qfg_-ugK.js";
import "./auto-linked-file-ref-Bg0cRVxq.js";
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
