import { isRecord } from "../utils.js";
function normalizeAllowedDomains(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const deduped = [
        ...new Set(value
            .map((entry) => (typeof entry === "string" ? entry.trim() : null))
            .filter((entry) => Boolean(entry))),
    ];
    return deduped.length > 0 ? deduped : undefined;
}
function normalizeContextSize(value) {
    if (value === "low" || value === "medium" || value === "high") {
        return value;
    }
    return undefined;
}
function normalizeMode(value) {
    return value === "live" ? "live" : "cached";
}
function normalizeUserLocation(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const location = {
        country: typeof value.country === "string" ? value.country.trim() || undefined : undefined,
        region: typeof value.region === "string" ? value.region.trim() || undefined : undefined,
        city: typeof value.city === "string" ? value.city.trim() || undefined : undefined,
        timezone: typeof value.timezone === "string" ? value.timezone.trim() || undefined : undefined,
    };
    return location.country || location.region || location.city || location.timezone
        ? location
        : undefined;
}
export function resolveCodexNativeWebSearchConfig(config) {
    const nativeConfig = config?.tools?.web?.search?.openaiCodex;
    return {
        enabled: nativeConfig?.enabled === true,
        mode: normalizeMode(nativeConfig?.mode),
        allowedDomains: normalizeAllowedDomains(nativeConfig?.allowedDomains),
        contextSize: normalizeContextSize(nativeConfig?.contextSize),
        userLocation: normalizeUserLocation(nativeConfig?.userLocation),
    };
}
export function describeCodexNativeWebSearch(config) {
    if (config?.tools?.web?.search?.enabled === false) {
        return undefined;
    }
    const nativeConfig = resolveCodexNativeWebSearchConfig(config);
    if (!nativeConfig.enabled) {
        return undefined;
    }
    return `Codex native search: ${nativeConfig.mode} for Codex-capable models`;
}
