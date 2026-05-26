//#region src/agents/timeout.ts
const DEFAULT_AGENT_TIMEOUT_SECONDS = 2880 * 60;
const MAX_SAFE_TIMEOUT_MS = 2147e6;
const normalizeNumber = (value) => typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : void 0;
function resolveAgentTimeoutSeconds(cfg) {
	const seconds = normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds) ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
	return Math.max(seconds, 1);
}
function resolveAgentTimeoutMs(opts) {
	const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
	const clampTimeoutMs = (valueMs) => Math.min(Math.max(valueMs, minMs), MAX_SAFE_TIMEOUT_MS);
	const defaultMs = clampTimeoutMs(resolveAgentTimeoutSeconds(opts.cfg) * 1e3);
	const NO_TIMEOUT_MS = MAX_SAFE_TIMEOUT_MS;
	const overrideMs = normalizeNumber(opts.overrideMs);
	if (overrideMs !== void 0) {
		if (overrideMs === 0) return NO_TIMEOUT_MS;
		if (overrideMs < 0) return defaultMs;
		return clampTimeoutMs(overrideMs);
	}
	const overrideSeconds = normalizeNumber(opts.overrideSeconds);
	if (overrideSeconds !== void 0) {
		if (overrideSeconds === 0) return NO_TIMEOUT_MS;
		if (overrideSeconds < 0) return defaultMs;
		return clampTimeoutMs(overrideSeconds * 1e3);
	}
	return defaultMs;
}
//#endregion
export { resolveAgentTimeoutMs as t };
