import { it as resolveConfigDir } from "./entry.js";
import { c as detectMime, l as extensionForMime } from "./image-ops-Z3_QkQPj.js";
import path from "node:path";
import { createWriteStream } from "node:fs";
import fs$1 from "node:fs/promises";
import crypto from "node:crypto";
import { request } from "node:https";
import { pipeline } from "node:stream/promises";

//#region src/media/store.ts
const resolveMediaDir = () => path.join(resolveConfigDir(), "media");
const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
const MAX_BYTES = MEDIA_MAX_BYTES;
const DEFAULT_TTL_MS = 120 * 1e3;
/**
* Sanitize a filename for cross-platform safety.
* Removes chars unsafe on Windows/SharePoint/all platforms.
* Keeps: alphanumeric, dots, hyphens, underscores, Unicode letters/numbers.
*/
function sanitizeFilename(name) {
	const trimmed = name.trim();
	if (!trimmed) return "";
	return trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}
function getMediaDir() {
	return resolveMediaDir();
}
async function ensureMediaDir() {
	const mediaDir = resolveMediaDir();
	await fs$1.mkdir(mediaDir, {
		recursive: true,
		mode: 448
	});
	return mediaDir;
}
async function saveMediaBuffer(buffer, contentType, subdir = "inbound", maxBytes = MAX_BYTES, originalFilename) {
	if (buffer.byteLength > maxBytes) throw new Error(`Media exceeds ${(maxBytes / (1024 * 1024)).toFixed(0)}MB limit`);
	const dir = path.join(resolveMediaDir(), subdir);
	await fs$1.mkdir(dir, {
		recursive: true,
		mode: 448
	});
	const uuid = crypto.randomUUID();
	const headerExt = extensionForMime(contentType?.split(";")[0]?.trim() ?? void 0);
	const mime = await detectMime({
		buffer,
		headerMime: contentType
	});
	const ext = headerExt ?? extensionForMime(mime) ?? "";
	let id;
	if (originalFilename) {
		const base = path.parse(originalFilename).name;
		const sanitized = sanitizeFilename(base);
		id = sanitized ? `${sanitized}---${uuid}${ext}` : `${uuid}${ext}`;
	} else id = ext ? `${uuid}${ext}` : uuid;
	const dest = path.join(dir, id);
	await fs$1.writeFile(dest, buffer, { mode: 384 });
	return {
		id,
		path: dest,
		size: buffer.byteLength,
		contentType: mime
	};
}

//#endregion
export { getMediaDir as n, saveMediaBuffer as r, ensureMediaDir as t };