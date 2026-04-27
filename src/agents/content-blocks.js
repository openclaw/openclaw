export function collectTextContentBlocks(content) {
    if (!Array.isArray(content)) {
        return [];
    }
    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== "object") {
            continue;
        }
        const rec = block;
        if (rec.type === "text" && typeof rec.text === "string") {
            parts.push(rec.text);
        }
    }
    return parts;
}
