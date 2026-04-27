function escapeRegex(value) {
    // Standard "escape string for regex literal" pattern.
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function compileGlobPattern(params) {
    const normalized = params.normalize(params.raw);
    if (!normalized) {
        return { kind: "exact", value: "" };
    }
    if (normalized === "*") {
        return { kind: "all" };
    }
    if (!normalized.includes("*")) {
        return { kind: "exact", value: normalized };
    }
    return {
        kind: "regex",
        value: new RegExp(`^${escapeRegex(normalized).replaceAll("\\*", ".*")}$`),
    };
}
export function compileGlobPatterns(params) {
    if (!Array.isArray(params.raw)) {
        return [];
    }
    return params.raw
        .map((raw) => compileGlobPattern({ raw, normalize: params.normalize }))
        .filter((pattern) => pattern.kind !== "exact" || pattern.value);
}
export function matchesAnyGlobPattern(value, patterns) {
    for (const pattern of patterns) {
        if (pattern.kind === "all") {
            return true;
        }
        if (pattern.kind === "exact" && value === pattern.value) {
            return true;
        }
        if (pattern.kind === "regex" && pattern.value.test(value)) {
            return true;
        }
    }
    return false;
}
