import "./utils-CRkrr5e6.js";
import "./types.secrets-0GsiwJ5t.js";
import "./setup-helpers-CIcTlEPx.js";
import "./setup-binary-RjT4HHFg.js";
import "./setup-wizard-helpers-CqHo9ArT.js";
import "./setup-wizard-proxy-rc7pXz-s.js";
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
export { formatResolvedUnresolvedNote as t };
