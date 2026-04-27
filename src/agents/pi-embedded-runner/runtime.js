export function normalizeEmbeddedAgentRuntime(raw) {
    const value = raw?.trim();
    if (!value) {
        return "pi";
    }
    if (value === "pi") {
        return "pi";
    }
    if (value === "auto") {
        return "auto";
    }
    if (value === "codex-app-server") {
        return "codex";
    }
    return value;
}
export function resolveEmbeddedAgentRuntime(env = process.env) {
    return normalizeEmbeddedAgentRuntime(env.OPENCLAW_AGENT_RUNTIME?.trim());
}
export function resolveEmbeddedAgentHarnessFallback(env = process.env) {
    const raw = env.OPENCLAW_AGENT_HARNESS_FALLBACK?.trim().toLowerCase();
    if (raw === "pi" || raw === "none") {
        return raw;
    }
    return undefined;
}
