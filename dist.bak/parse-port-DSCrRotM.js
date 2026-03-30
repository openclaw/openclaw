//#region src/cli/shared/parse-port.ts
function parsePort(raw) {
	if (raw === void 0 || raw === null) return null;
	const value = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "bigint" ? raw.toString() : null;
	if (value === null) return null;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}

//#endregion
export { parsePort as t };