//#region src/cli/parse-timeout.ts
function parseTimeoutMs(raw) {
	if (raw === void 0 || raw === null) return;
	let value = NaN;
	if (typeof raw === "number") value = raw;
	else if (typeof raw === "bigint") value = Number(raw);
	else if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return;
		value = Number.parseInt(trimmed, 10);
	}
	return Number.isFinite(value) ? value : void 0;
}
function invalidTimeout(value) {
	const suffix = value ? ` Received: "${value}".` : "";
	return /* @__PURE__ */ new Error(`Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000.${suffix}`);
}
function parseTimeoutMsWithFallback(raw, fallbackMs, options = {}) {
	if (raw === void 0 || raw === null) return fallbackMs;
	const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" || typeof raw === "bigint" ? String(raw) : null;
	if (value === null) {
		if (options.invalidType === "error") throw invalidTimeout();
		return fallbackMs;
	}
	if (!value) return fallbackMs;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) throw invalidTimeout(value);
	return parsed;
}
//#endregion
export { parseTimeoutMsWithFallback as n, parseTimeoutMs as t };
