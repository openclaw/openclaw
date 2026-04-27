import { normalizeStringEntries } from "../../shared/string-normalization.js";
export function normalizeSkillFilter(skillFilter) {
    if (skillFilter === undefined) {
        return undefined;
    }
    return normalizeStringEntries(skillFilter);
}
export function normalizeSkillFilterForComparison(skillFilter) {
    const normalized = normalizeSkillFilter(skillFilter);
    if (normalized === undefined) {
        return undefined;
    }
    return Array.from(new Set(normalized)).toSorted();
}
export function matchesSkillFilter(cached, next) {
    const cachedNormalized = normalizeSkillFilterForComparison(cached);
    const nextNormalized = normalizeSkillFilterForComparison(next);
    if (cachedNormalized === undefined || nextNormalized === undefined) {
        return cachedNormalized === nextNormalized;
    }
    if (cachedNormalized.length !== nextNormalized.length) {
        return false;
    }
    return cachedNormalized.every((entry, index) => entry === nextNormalized[index]);
}
