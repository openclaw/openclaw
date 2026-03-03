function addName(names, value) {
    if (typeof value !== "string") {
        return;
    }
    const trimmed = value.trim();
    if (trimmed) {
        names.add(trimmed);
    }
}
export function collectAllowedToolNames(params) {
    const names = new Set();
    for (const tool of params.tools) {
        addName(names, tool.name);
    }
    for (const tool of params.clientTools ?? []) {
        addName(names, tool.function?.name);
    }
    return names;
}
