import "./utils-CAcKzQHY.js";
import "./types.secrets-BcE0iOnr.js";
import "./setup-helpers-BC9z9VvG.js";
import "./setup-binary-CkxwtHTf.js";
import "./setup-wizard-helpers-CQhpROmW.js";
import "./setup-wizard-proxy-Bf0n9XFS.js";
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
export { formatResolvedUnresolvedNote as t };
