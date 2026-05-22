import "./utils-CCskKJVV.js";
import "./types.secrets-CyuYZNvB.js";
import "./setup-helpers-t5I1EDve.js";
import "./setup-wizard-helpers-D8cUTbTq.js";
import "./setup-binary-o6G68Oab.js";
import "./setup-wizard-proxy-CDIFcJHW.js";
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
export { formatResolvedUnresolvedNote as t };
