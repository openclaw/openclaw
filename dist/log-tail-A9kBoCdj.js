import { d as resolveRedactOptions, o as redactSensitiveLines } from "./redact-ok5Q8nmw.js";
import { n as clamp } from "./utils-sBTEdeml.js";
import { a as getResolvedLoggerSettings } from "./logger-Dg9dVaLI.js";
import "./logging-B2Kt4cNB.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/logging/log-tail.ts
const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_BYTES = 25e4;
const MAX_LIMIT = 5e3;
const MAX_BYTES = 1e6;
const ROLLING_LOG_RE = /^openclaw-\d{4}-\d{2}-\d{2}\.log$/;
function isRollingLogFile(file) {
	return ROLLING_LOG_RE.test(path.basename(file));
}
async function resolveLogFile(file) {
	if (await fs.stat(file).catch(() => null)) return file;
	if (!isRollingLogFile(file)) return file;
	const dir = path.dirname(file);
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
	if (!entries) return file;
	return (await Promise.all(entries.filter((entry) => entry.isFile() && ROLLING_LOG_RE.test(entry.name)).map(async (entry) => {
		const fullPath = path.join(dir, entry.name);
		const fileStat = await fs.stat(fullPath).catch(() => null);
		return fileStat ? {
			path: fullPath,
			mtimeMs: fileStat.mtimeMs
		} : null;
	}))).filter((entry) => Boolean(entry)).toSorted((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? file;
}
async function readLogSlice(params) {
	const stat = await fs.stat(params.file).catch(() => null);
	if (!stat) return {
		cursor: 0,
		size: 0,
		lines: [],
		truncated: false,
		reset: false
	};
	const size = stat.size;
	const maxBytes = clamp(params.maxBytes, 1, MAX_BYTES);
	const limit = clamp(params.limit, 1, MAX_LIMIT);
	let cursor = typeof params.cursor === "number" && Number.isFinite(params.cursor) ? Math.max(0, Math.floor(params.cursor)) : void 0;
	let reset = false;
	let truncated = false;
	let start = 0;
	if (cursor != null) if (cursor > size) {
		reset = true;
		start = Math.max(0, size - maxBytes);
		truncated = start > 0;
	} else {
		start = cursor;
		if (size - start > maxBytes) {
			reset = true;
			truncated = true;
			start = Math.max(0, size - maxBytes);
		}
	}
	else {
		start = Math.max(0, size - maxBytes);
		truncated = start > 0;
	}
	if (size === 0 || size <= start) return {
		cursor: size,
		size,
		lines: [],
		truncated,
		reset
	};
	const handle = await fs.open(params.file, "r");
	try {
		let prefix = "";
		if (start > 0) {
			const prefixBuf = Buffer.alloc(1);
			const prefixRead = await handle.read(prefixBuf, 0, 1, start - 1);
			prefix = prefixBuf.toString("utf8", 0, prefixRead.bytesRead);
		}
		const length = Math.max(0, size - start);
		const buffer = Buffer.alloc(length);
		const readResult = await handle.read(buffer, 0, length, start);
		let lines = buffer.toString("utf8", 0, readResult.bytesRead).split("\n");
		if (start > 0 && prefix !== "\n") lines = lines.slice(1);
		if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
		if (lines.length > limit) lines = lines.slice(lines.length - limit);
		cursor = size;
		return {
			cursor,
			size,
			lines,
			truncated,
			reset
		};
	} finally {
		await handle.close();
	}
}
async function readConfiguredLogTail(params) {
	const file = await resolveLogFile(getResolvedLoggerSettings().file);
	const result = await readLogSlice({
		file,
		cursor: params?.cursor,
		limit: params?.limit ?? DEFAULT_LIMIT,
		maxBytes: params?.maxBytes ?? DEFAULT_MAX_BYTES
	});
	const redaction = resolveRedactOptions();
	return {
		file,
		...result,
		lines: redactSensitiveLines(result.lines, redaction)
	};
}
//#endregion
export { resolveLogFile as n, readConfiguredLogTail as t };
