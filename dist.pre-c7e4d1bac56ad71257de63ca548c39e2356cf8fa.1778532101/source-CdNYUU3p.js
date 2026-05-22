import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/agents/skills/source.ts
function resolveSkillSource(skill) {
	const compatSkill = skill;
	const canonical = normalizeOptionalString(compatSkill.source) ?? "";
	if (canonical) return canonical;
	return (normalizeOptionalString(compatSkill.sourceInfo?.source) ?? "") || "unknown";
}
//#endregion
export { resolveSkillSource as t };
