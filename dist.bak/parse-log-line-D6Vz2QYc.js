//#region src/logging/parse-log-line.ts
function extractMessage(value) {
	const parts = [];
	for (const key of Object.keys(value)) {
		if (!/^\d+$/.test(key)) continue;
		const item = value[key];
		if (typeof item === "string") parts.push(item);
		else if (item != null) parts.push(JSON.stringify(item));
	}
	return parts.join(" ");
}
function parseMetaName(raw) {
	if (typeof raw !== "string") return {};
	try {
		const parsed = JSON.parse(raw);
		return {
			subsystem: typeof parsed.subsystem === "string" ? parsed.subsystem : void 0,
			module: typeof parsed.module === "string" ? parsed.module : void 0
		};
	} catch {
		return {};
	}
}
function parseLogLine(raw) {
	try {
		const parsed = JSON.parse(raw);
		const meta = parsed._meta;
		const nameMeta = parseMetaName(meta?.name);
		const levelRaw = typeof meta?.logLevelName === "string" ? meta.logLevelName : void 0;
		return {
			time: typeof parsed.time === "string" ? parsed.time : typeof meta?.date === "string" ? meta.date : void 0,
			level: levelRaw ? levelRaw.toLowerCase() : void 0,
			subsystem: nameMeta.subsystem,
			module: nameMeta.module,
			message: extractMessage(parsed),
			raw
		};
	} catch {
		return null;
	}
}

//#endregion
export { parseLogLine as t };