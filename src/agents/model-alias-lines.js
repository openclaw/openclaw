export function buildModelAliasLines(cfg) {
    const models = cfg?.agents?.defaults?.models ?? {};
    const entries = [];
    for (const [keyRaw, entryRaw] of Object.entries(models)) {
        const model = String(keyRaw ?? "").trim();
        if (!model) {
            continue;
        }
        const alias = String(entryRaw?.alias ?? "").trim();
        if (!alias) {
            continue;
        }
        entries.push({ alias, model });
    }
    return entries
        .toSorted((a, b) => a.alias.localeCompare(b.alias))
        .map((entry) => `- ${entry.alias}: ${entry.model}`);
}
