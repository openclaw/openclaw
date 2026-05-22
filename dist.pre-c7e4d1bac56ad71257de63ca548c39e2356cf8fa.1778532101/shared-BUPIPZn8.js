import "./utils-D5swhEXt.js";
import fs from "node:fs";
import path from "node:path";
//#region src/secrets/shared.ts
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function parseEnvValue(raw) {
	const trimmed = raw.trim();
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
	return trimmed;
}
function normalizePositiveInt(value, fallback) {
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.floor(value));
	return Math.max(1, Math.floor(fallback));
}
function parseDotPath(pathname) {
	return pathname.split(".").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}
function toDotPath(segments) {
	return segments.join(".");
}
function ensureDirForFile(filePath) {
	fs.mkdirSync(path.dirname(filePath), {
		recursive: true,
		mode: 448
	});
}
function writeJsonFileSecure(pathname, value) {
	ensureDirForFile(pathname);
	fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	fs.chmodSync(pathname, 384);
}
function readTextFileIfExists(pathname) {
	if (!fs.existsSync(pathname)) return null;
	return fs.readFileSync(pathname, "utf8");
}
function writeTextFileAtomic(pathname, value, mode = 384) {
	ensureDirForFile(pathname);
	const tempPath = `${pathname}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tempPath, value, "utf8");
	fs.chmodSync(tempPath, mode);
	fs.renameSync(tempPath, pathname);
}
//#endregion
export { parseEnvValue as a, writeJsonFileSecure as c, parseDotPath as i, writeTextFileAtomic as l, isNonEmptyString as n, readTextFileIfExists as o, normalizePositiveInt as r, toDotPath as s, ensureDirForFile as t };
