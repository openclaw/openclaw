import { isDangerousHostEnvVarName } from "../infra/host-env-security.js";
export function isMcpConfigRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function toMcpFilteredStringRecord(value, options) {
    if (!isMcpConfigRecord(value)) {
        return undefined;
    }
    let droppedByKey = false;
    const entries = Object.entries(value)
        .map(([key, entry]) => {
        if (options?.shouldDropKey?.(key)) {
            droppedByKey = true;
            options?.onDroppedEntry?.(key, entry);
            return null;
        }
        if (typeof entry === "string") {
            return [key, entry];
        }
        if (typeof entry === "number" || typeof entry === "boolean") {
            return [key, String(entry)];
        }
        options?.onDroppedEntry?.(key, entry);
        return null;
    })
        .filter((entry) => entry !== null);
    if (entries.length === 0 && droppedByKey && options?.preserveEmptyWhenKeysDropped) {
        return {};
    }
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
export function toMcpStringRecord(value, options) {
    return toMcpFilteredStringRecord(value, options);
}
export function toMcpEnvRecord(value, options) {
    return toMcpFilteredStringRecord(value, {
        ...options,
        preserveEmptyWhenKeysDropped: true,
        shouldDropKey: (key) => isDangerousHostEnvVarName(key),
    });
}
export function toMcpStringArray(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const entries = value.filter((entry) => typeof entry === "string");
    return entries.length > 0 ? entries : [];
}
