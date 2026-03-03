import { compileGlobPatterns, matchesAnyGlobPattern } from "../../glob-pattern.js";
function normalizeGlob(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase();
}
export function makeToolPrunablePredicate(match) {
    const deny = compileGlobPatterns({ raw: match.deny, normalize: normalizeGlob });
    const allow = compileGlobPatterns({ raw: match.allow, normalize: normalizeGlob });
    return (toolName) => {
        const normalized = normalizeGlob(toolName);
        if (matchesAnyGlobPattern(normalized, deny)) {
            return false;
        }
        if (allow.length === 0) {
            return true;
        }
        return matchesAnyGlobPattern(normalized, allow);
    };
}
