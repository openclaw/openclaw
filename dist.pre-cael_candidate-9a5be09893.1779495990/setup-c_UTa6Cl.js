import "./utils-BlCbsks0.js";
import "./types.secrets-BM3-Vmz4.js";
import "./setup-helpers-BC9z9VvG.js";
import "./setup-binary-B8Klf5j1.js";
import "./setup-wizard-helpers-CfeC-9c1.js";
import "./setup-wizard-proxy-Bc5w393S.js";
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
export { formatResolvedUnresolvedNote as t };
