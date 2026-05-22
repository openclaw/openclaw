import "./utils-CpmNtyoq.js";
import "./types.secrets-Co1lNtpa.js";
import "./setup-helpers-BpCN1yCL.js";
import "./setup-binary-CR2qe6Rl.js";
import "./setup-wizard-helpers-A0ibr4F4.js";
import "./setup-wizard-proxy-BLJ21ysT.js";
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
export { formatResolvedUnresolvedNote as t };
