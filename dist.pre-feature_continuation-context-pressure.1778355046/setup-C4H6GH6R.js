import "./utils-D5swhEXt.js";
import "./types.secrets-CL51SR4g.js";
import "./setup-helpers-CESD8ZBk.js";
import "./setup-wizard-helpers-BszlehmC.js";
import "./setup-binary-D7Oclfet.js";
import "./setup-wizard-proxy-CXBdtZYF.js";
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
export { formatResolvedUnresolvedNote as t };
