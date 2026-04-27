import { normalizeOptionalString } from "../../shared/string-coerce.js";
export function resolveSkillSource(skill) {
    const compatSkill = skill;
    const canonical = normalizeOptionalString(compatSkill.source) ?? "";
    if (canonical) {
        return canonical;
    }
    const legacy = normalizeOptionalString(compatSkill.sourceInfo?.source) ?? "";
    return legacy || "unknown";
}
