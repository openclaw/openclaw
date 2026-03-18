import { l as normalizeAgentId, s as init_session_key } from "./session-key-B-Mu-04L.js";
//#region src/gateway/hooks-policy.ts
init_session_key();
function resolveAllowedAgentIds(raw) {
	if (!Array.isArray(raw)) return;
	const allowed = /* @__PURE__ */ new Set();
	let hasWildcard = false;
	for (const entry of raw) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		if (trimmed === "*") {
			hasWildcard = true;
			break;
		}
		allowed.add(normalizeAgentId(trimmed));
	}
	if (hasWildcard) return;
	return allowed;
}
//#endregion
export { resolveAllowedAgentIds as t };
