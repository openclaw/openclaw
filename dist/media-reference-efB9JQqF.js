import { w as safeFileURLToPath } from "./fs-safe-CV86zY9G.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./local-file-access-CBe_wA_B.js";
import { l as resolveMediaBufferPath, s as getMediaDir } from "./store-rQFzzX5P.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/media/media-reference.ts
var MediaReferenceError = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "MediaReferenceError";
	}
};
function normalizeMediaReferenceSource(source) {
	const trimmed = source.trim();
	if (/^media:\/\//i.test(trimmed)) return trimmed;
	return trimmed.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
}
function classifyMediaReferenceSource(source, options) {
	const allowDataUrl = options?.allowDataUrl ?? true;
	const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(source);
	const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(source);
	const isFileUrl = /^file:/i.test(source);
	const isHttpUrl = /^https?:\/\//i.test(source);
	const isDataUrl = /^data:/i.test(source);
	const isMediaStoreUrl = /^media:\/\//i.test(source);
	return {
		hasScheme,
		hasUnsupportedScheme: hasScheme && !looksLikeWindowsDrivePath && !isFileUrl && !isHttpUrl && !isMediaStoreUrl && !(allowDataUrl && isDataUrl),
		isDataUrl,
		isFileUrl,
		isHttpUrl,
		isMediaStoreUrl,
		looksLikeWindowsDrivePath
	};
}
function maybeLocalPathFromSource(source) {
	if (/^file:/i.test(source)) try {
		return safeFileURLToPath(source);
	} catch {
		return null;
	}
	if (source.startsWith("~")) return resolveUserPath(source);
	if (path.isAbsolute(source)) return source;
	return null;
}
function relativePathEscapesBase(relativePath) {
	return relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || path.isAbsolute(relativePath);
}
async function resolvePathForContainment(candidate) {
	try {
		return await fs.realpath(candidate);
	} catch {
		return path.resolve(candidate);
	}
}
async function resolveInboundMediaUri(normalizedSource) {
	if (!/^media:\/\//i.test(normalizedSource)) return null;
	let parsed;
	try {
		parsed = new URL(normalizedSource);
	} catch (err) {
		throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`, { cause: err });
	}
	if (parsed.hostname !== "inbound") throw new MediaReferenceError("path-not-allowed", `Unsupported media URI location: ${parsed.hostname || "(missing)"}`);
	let id;
	try {
		id = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
	} catch (err) {
		throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`, { cause: err });
	}
	if (!id || id.includes("/") || id.includes("\\")) throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`);
	return {
		id,
		normalizedSource,
		physicalPath: await resolveInboundMediaPath(id, normalizedSource),
		sourceType: "uri"
	};
}
async function resolveInboundMediaReference(source) {
	const normalizedSource = normalizeMediaReferenceSource(source);
	if (!normalizedSource) return null;
	const uriSource = await resolveInboundMediaUri(normalizedSource);
	if (uriSource) return uriSource;
	const localPath = maybeLocalPathFromSource(normalizedSource);
	if (!localPath) return null;
	const rawInboundDir = path.resolve(getMediaDir(), "inbound");
	const rawResolvedPath = path.resolve(localPath);
	const rawRel = path.relative(rawInboundDir, rawResolvedPath);
	const rel = rawRel && !relativePathEscapesBase(rawRel) ? rawRel : path.relative(await resolvePathForContainment(rawInboundDir), await resolvePathForContainment(localPath));
	if (!rel || relativePathEscapesBase(rel) || rel.includes(path.sep)) return null;
	return {
		id: rel,
		normalizedSource,
		physicalPath: await resolveInboundMediaPath(rel, normalizedSource),
		sourceType: "path"
	};
}
async function resolveMediaReferenceLocalPath(source) {
	const normalizedSource = normalizeMediaReferenceSource(source);
	return (await resolveInboundMediaReference(normalizedSource))?.physicalPath ?? normalizedSource;
}
async function resolveInboundMediaPath(id, source) {
	try {
		return await resolveMediaBufferPath(id, "inbound");
	} catch (err) {
		throw new MediaReferenceError("invalid-path", err instanceof Error ? err.message : `Invalid media reference: ${source}`, { cause: err });
	}
}
//#endregion
export { resolveMediaReferenceLocalPath as a, resolveInboundMediaReference as i, classifyMediaReferenceSource as n, normalizeMediaReferenceSource as r, MediaReferenceError as t };
