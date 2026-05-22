import { s as normalizeStringEntries } from "./string-normalization-C5SGsaST.js";
//#region src/agents/skills/filter.ts
function normalizeSkillFilter(skillFilter) {
	if (skillFilter === void 0) return;
	return normalizeStringEntries(skillFilter);
}
function normalizeSkillFilterForComparison(skillFilter) {
	const normalized = normalizeSkillFilter(skillFilter);
	if (normalized === void 0) return;
	return Array.from(new Set(normalized)).toSorted();
}
function matchesSkillFilter(cached, next) {
	const cachedNormalized = normalizeSkillFilterForComparison(cached);
	const nextNormalized = normalizeSkillFilterForComparison(next);
	if (cachedNormalized === void 0 || nextNormalized === void 0) return cachedNormalized === nextNormalized;
	if (cachedNormalized.length !== nextNormalized.length) return false;
	return cachedNormalized.every((entry, index) => entry === nextNormalized[index]);
}
//#endregion
export { normalizeSkillFilter as n, normalizeSkillFilterForComparison as r, matchesSkillFilter as t };
