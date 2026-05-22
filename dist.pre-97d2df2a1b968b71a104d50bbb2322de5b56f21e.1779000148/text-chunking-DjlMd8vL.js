import "./safe-text-BqXgiOsp.js";
import { l as chunkTextByBreakResolver } from "./chunk-DoeRNEZX.js";
import "./tables-DyXy9Fki.js";
import "./chunk-items-EZUNZU7J.js";
import "./auto-linked-file-ref-mhsUxLHP.js";
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
