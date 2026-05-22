import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/agents/prompt-cache-stability.ts
function normalizeStructuredPromptSection(text) {
	return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}
function normalizePromptCapabilityIds(capabilities) {
	const seen = /* @__PURE__ */ new Set();
	const normalized = [];
	for (const capability of capabilities) {
		const value = normalizeLowercaseStringOrEmpty(normalizeStructuredPromptSection(capability));
		if (!value || seen.has(value)) continue;
		seen.add(value);
		normalized.push(value);
	}
	return normalized.toSorted((left, right) => left.localeCompare(right));
}
//#endregion
export { normalizeStructuredPromptSection as n, normalizePromptCapabilityIds as t };
