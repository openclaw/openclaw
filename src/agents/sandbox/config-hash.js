import { hashTextSha256 } from "./hash.js";
function normalizeForHash(value) {
    if (value === undefined) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value.map(normalizeForHash).filter((item) => item !== undefined);
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
        const normalized = {};
        for (const [key, entryValue] of entries) {
            const next = normalizeForHash(entryValue);
            if (next !== undefined) {
                normalized[key] = next;
            }
        }
        return normalized;
    }
    return value;
}
export function computeSandboxConfigHash(input) {
    return computeHash(input);
}
export function computeSandboxBrowserConfigHash(input) {
    return computeHash(input);
}
function computeHash(input) {
    const payload = normalizeForHash(input);
    const raw = JSON.stringify(payload);
    return hashTextSha256(raw);
}
