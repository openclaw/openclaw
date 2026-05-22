import { c as normalizeAgentId } from "./session-key-C0K0uhmG.js";
//#region src/gateway/hooks-policy.ts
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
