import "./utils-sBTEdeml.js";
import { i as replaceFileAtomicSync } from "./replace-file-C7_Inj8B.js";
import { n as privateFileStoreSync } from "./private-file-store-DMtyjgoc.js";
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
	privateFileStoreSync(path.dirname(pathname)).writeJson(path.basename(pathname), value, { trailingNewline: true });
}
function readTextFileIfExists(pathname) {
	if (!fs.existsSync(pathname)) return null;
	return fs.readFileSync(pathname, "utf8");
}
function writeTextFileAtomic(pathname, value, mode = 384) {
	if (mode !== 384) {
		replaceFileAtomicSync({
			filePath: pathname,
			content: value,
			mode,
			tempPrefix: ".openclaw-secrets"
		});
		return;
	}
	privateFileStoreSync(path.dirname(pathname)).writeText(path.basename(pathname), value);
}
//#endregion
export { parseEnvValue as a, writeJsonFileSecure as c, parseDotPath as i, writeTextFileAtomic as l, isNonEmptyString as n, readTextFileIfExists as o, normalizePositiveInt as r, toDotPath as s, ensureDirForFile as t };
