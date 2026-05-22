import "./utils-CpmNtyoq.js";
import "./types.secrets-11Owfj8f.js";
import "./setup-helpers-C2owaOKH.js";
import "./setup-binary-CzW9hU-F.js";
import "./setup-wizard-helpers-eQdcj31v.js";
import "./setup-wizard-proxy-CnPqsipJ.js";
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
export { formatResolvedUnresolvedNote as t };
