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

//#endregion
export { parseTimeoutMs as t };