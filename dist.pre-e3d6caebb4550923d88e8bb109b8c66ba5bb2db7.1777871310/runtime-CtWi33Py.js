//#region src/agents/pi-embedded-runner/runtime.ts
function normalizeEmbeddedAgentRuntime(raw) {
	const value = raw?.trim();
	if (!value) return "pi";
	if (value === "pi") return "pi";
	if (value === "auto") return "auto";
	if (value === "codex-app-server") return "codex";
	return value;
}
function resolveEmbeddedAgentRuntime(env = process.env) {
	return normalizeEmbeddedAgentRuntime(env.OPENCLAW_AGENT_RUNTIME?.trim());
}
function resolveEmbeddedAgentHarnessFallback(env = process.env) {
	const raw = env.OPENCLAW_AGENT_HARNESS_FALLBACK?.trim().toLowerCase();
	if (raw === "pi" || raw === "none") return raw;
}
//#endregion
export { resolveEmbeddedAgentHarnessFallback as n, resolveEmbeddedAgentRuntime as r, normalizeEmbeddedAgentRuntime as t };
