import "./utils-sBTEdeml.js";
import "./types.secrets-DwPik3M8.js";
import "./setup-helpers-BC9z9VvG.js";
import "./setup-binary-BeEfo44C.js";
import "./setup-wizard-helpers-Dbpzm32P.js";
import "./setup-wizard-proxy-B15glc8O.js";
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
export { formatResolvedUnresolvedNote as t };
