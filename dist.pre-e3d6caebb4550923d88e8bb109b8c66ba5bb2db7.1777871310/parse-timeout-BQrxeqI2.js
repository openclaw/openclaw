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
function parseTimeoutMsWithFallback(raw, fallbackMs, options = {}) {
	if (raw === void 0 || raw === null) return fallbackMs;
	const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" || typeof raw === "bigint" ? String(raw) : null;
	if (value === null) {
		if (options.invalidType === "error") throw new Error("invalid --timeout");
		return fallbackMs;
	}
	if (!value) return fallbackMs;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid --timeout: ${value}`);
	return parsed;
}
//#endregion
export { parseTimeoutMsWithFallback as n, parseTimeoutMs as t };
