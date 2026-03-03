import { normalizeProviderId } from "./model-selection.js";
const KEY_SPLIT_RE = /[\s,;]+/g;
const GOOGLE_LIVE_SINGLE_KEY = "OPENCLAW_LIVE_GEMINI_KEY";
const PROVIDER_PREFIX_OVERRIDES = {
    google: "GEMINI",
    "google-vertex": "GEMINI",
};
const PROVIDER_API_KEY_CONFIG = {
    anthropic: {
        liveSingle: "OPENCLAW_LIVE_ANTHROPIC_KEY",
        listVar: "OPENCLAW_LIVE_ANTHROPIC_KEYS",
        primaryVar: "ANTHROPIC_API_KEY",
        prefixedVar: "ANTHROPIC_API_KEY_",
    },
    google: {
        liveSingle: GOOGLE_LIVE_SINGLE_KEY,
        listVar: "GEMINI_API_KEYS",
        primaryVar: "GEMINI_API_KEY",
        prefixedVar: "GEMINI_API_KEY_",
    },
    "google-vertex": {
        liveSingle: GOOGLE_LIVE_SINGLE_KEY,
        listVar: "GEMINI_API_KEYS",
        primaryVar: "GEMINI_API_KEY",
        prefixedVar: "GEMINI_API_KEY_",
    },
    openai: {
        liveSingle: "OPENCLAW_LIVE_OPENAI_KEY",
        listVar: "OPENAI_API_KEYS",
        primaryVar: "OPENAI_API_KEY",
        prefixedVar: "OPENAI_API_KEY_",
    },
};
function parseKeyList(raw) {
    if (!raw) {
        return [];
    }
    return raw
        .split(KEY_SPLIT_RE)
        .map((value) => value.trim())
        .filter(Boolean);
}
function collectEnvPrefixedKeys(prefix) {
    const keys = [];
    for (const [name, value] of Object.entries(process.env)) {
        if (!name.startsWith(prefix)) {
            continue;
        }
        const trimmed = value?.trim();
        if (!trimmed) {
            continue;
        }
        keys.push(trimmed);
    }
    return keys;
}
function resolveProviderApiKeyConfig(provider) {
    const normalized = normalizeProviderId(provider);
    const custom = PROVIDER_API_KEY_CONFIG[normalized];
    const base = PROVIDER_PREFIX_OVERRIDES[normalized] ?? normalized.toUpperCase().replace(/-/g, "_");
    const liveSingle = custom?.liveSingle ?? `OPENCLAW_LIVE_${base}_KEY`;
    const listVar = custom?.listVar ?? `${base}_API_KEYS`;
    const primaryVar = custom?.primaryVar ?? `${base}_API_KEY`;
    const prefixedVar = custom?.prefixedVar ?? `${base}_API_KEY_`;
    if (normalized === "google" || normalized === "google-vertex") {
        return {
            liveSingle,
            listVar,
            primaryVar,
            prefixedVar,
            fallbackVars: ["GOOGLE_API_KEY"],
        };
    }
    return {
        liveSingle,
        listVar,
        primaryVar,
        prefixedVar,
        fallbackVars: [],
    };
}
export function collectProviderApiKeys(provider) {
    const config = resolveProviderApiKeyConfig(provider);
    const forcedSingle = config.liveSingle ? process.env[config.liveSingle]?.trim() : undefined;
    if (forcedSingle) {
        return [forcedSingle];
    }
    const fromList = parseKeyList(config.listVar ? process.env[config.listVar] : undefined);
    const primary = config.primaryVar ? process.env[config.primaryVar]?.trim() : undefined;
    const fromPrefixed = config.prefixedVar ? collectEnvPrefixedKeys(config.prefixedVar) : [];
    const fallback = config.fallbackVars
        .map((envVar) => process.env[envVar]?.trim())
        .filter(Boolean);
    const seen = new Set();
    const add = (value) => {
        if (!value) {
            return;
        }
        if (seen.has(value)) {
            return;
        }
        seen.add(value);
    };
    for (const value of fromList) {
        add(value);
    }
    add(primary);
    for (const value of fromPrefixed) {
        add(value);
    }
    for (const value of fallback) {
        add(value);
    }
    return Array.from(seen);
}
export function collectAnthropicApiKeys() {
    return collectProviderApiKeys("anthropic");
}
export function collectGeminiApiKeys() {
    return collectProviderApiKeys("google");
}
export function isApiKeyRateLimitError(message) {
    const lower = message.toLowerCase();
    if (lower.includes("rate_limit")) {
        return true;
    }
    if (lower.includes("rate limit")) {
        return true;
    }
    if (lower.includes("429")) {
        return true;
    }
    if (lower.includes("quota exceeded") || lower.includes("quota_exceeded")) {
        return true;
    }
    if (lower.includes("resource exhausted") || lower.includes("resource_exhausted")) {
        return true;
    }
    if (lower.includes("too many requests")) {
        return true;
    }
    return false;
}
export function isAnthropicRateLimitError(message) {
    return isApiKeyRateLimitError(message);
}
export function isAnthropicBillingError(message) {
    const lower = message.toLowerCase();
    if (lower.includes("credit balance")) {
        return true;
    }
    if (lower.includes("insufficient credit")) {
        return true;
    }
    if (lower.includes("insufficient credits")) {
        return true;
    }
    if (lower.includes("payment required")) {
        return true;
    }
    if (lower.includes("billing") && lower.includes("disabled")) {
        return true;
    }
    if (/["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\spayment/i.test(lower)) {
        return true;
    }
    return false;
}
