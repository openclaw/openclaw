function escapeTomlString(value) {
    return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
function formatTomlKey(key) {
    return /^[A-Za-z0-9_-]+$/.test(key) ? key : `"${escapeTomlString(key)}"`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function serializeTomlInlineValue(value) {
    if (typeof value === "string") {
        return `"${escapeTomlString(value)}"`;
    }
    if (typeof value === "number" || typeof value === "bigint") {
        return String(value);
    }
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => serializeTomlInlineValue(entry)).join(", ")}]`;
    }
    if (isRecord(value)) {
        return `{ ${Object.entries(value)
            .map(([key, entry]) => `${formatTomlKey(key)} = ${serializeTomlInlineValue(entry)}`)
            .join(", ")} }`;
    }
    throw new Error(`Unsupported TOML inline value: ${String(value)}`);
}
export function formatTomlConfigOverride(key, value) {
    return `${key}=${serializeTomlInlineValue(value)}`;
}
