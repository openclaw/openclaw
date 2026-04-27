import { normalizeOptionalString } from "../shared/string-coerce.js";
export function buildModelAliasLines(cfg) {
    const models = cfg?.agents?.defaults?.models ?? {};
    const entries = [];
    for (const [keyRaw, entryRaw] of Object.entries(models)) {
        const model = normalizeOptionalString(keyRaw) ?? "";
        if (!model) {
            continue;
        }
        const alias = normalizeOptionalString(entryRaw?.alias) ?? "";
        if (!alias) {
            continue;
        }
        entries.push({ alias, model });
    }
    return entries
        .toSorted((a, b) => a.alias.localeCompare(b.alias))
        .map((entry) => `- ${entry.alias}: ${entry.model}`);
}
