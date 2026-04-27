export function normalizeConversationText(value) {
    if (typeof value === "string") {
        return value.trim();
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
        return `${value}`.trim();
    }
    return "";
}
