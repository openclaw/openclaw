import "./utils-DG9b7Tlg.js";
import "./types.secrets-DYAh0rlj.js";
import "./setup-helpers-CmIT7u8P.js";
import "./setup-binary-C2x2-fuL.js";
import "./setup-wizard-helpers-Conwd62p.js";
import "./setup-wizard-proxy-DyvrK1s6.js";
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
export { formatResolvedUnresolvedNote as t };
