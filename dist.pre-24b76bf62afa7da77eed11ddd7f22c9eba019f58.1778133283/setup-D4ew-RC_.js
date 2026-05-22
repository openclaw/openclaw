import "./utils-D5swhEXt.js";
import "./types.secrets-BlhtUuXT.js";
import "./setup-helpers-B9-JV7kL.js";
import "./setup-wizard-helpers-CZv1sG0G.js";
import "./setup-binary-xPziGuXE.js";
import "./setup-wizard-proxy-CYn079ct.js";
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
export { formatResolvedUnresolvedNote as t };
