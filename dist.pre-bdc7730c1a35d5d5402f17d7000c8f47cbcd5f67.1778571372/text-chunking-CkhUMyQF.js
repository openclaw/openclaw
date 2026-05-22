import "./safe-text-BU-8vtYI.js";
import { l as chunkTextByBreakResolver } from "./chunk-Cwj1J7Kz.js";
import "./tables-Nh1Yv6rJ.js";
import "./chunk-items-C7CeCFwk.js";
import "./auto-linked-file-ref-B2H73N9r.js";
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
