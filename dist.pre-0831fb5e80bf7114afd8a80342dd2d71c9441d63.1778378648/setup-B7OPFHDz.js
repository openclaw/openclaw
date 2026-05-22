import "./utils-927g1oFZ.js";
import "./types.secrets-m6J7qPGz.js";
import "./setup-helpers-B9--ofM6.js";
import "./setup-binary-5jwVaOu_.js";
import "./setup-wizard-helpers-C4zdJ0Fe.js";
import "./setup-wizard-proxy-BaKY7ooP.js";
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
export { formatResolvedUnresolvedNote as t };
