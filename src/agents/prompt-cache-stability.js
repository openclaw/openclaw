import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
export function normalizeStructuredPromptSection(text) {
    return text
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .trim();
}
export function normalizePromptCapabilityIds(capabilities) {
    const seen = new Set();
    const normalized = [];
    for (const capability of capabilities) {
        const value = normalizeLowercaseStringOrEmpty(normalizeStructuredPromptSection(capability));
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        normalized.push(value);
    }
    return normalized.toSorted((left, right) => left.localeCompare(right));
}
