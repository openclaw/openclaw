import "./utils-CpmNtyoq.js";
import "./types.secrets-Co1lNtpa.js";
import "./setup-helpers-iIQ2C2CC.js";
import "./setup-binary-Cpn3hg5S.js";
import "./setup-wizard-helpers-B6iH-l9Y.js";
import "./setup-wizard-proxy-BKmSW4YI.js";
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
export { formatResolvedUnresolvedNote as t };
