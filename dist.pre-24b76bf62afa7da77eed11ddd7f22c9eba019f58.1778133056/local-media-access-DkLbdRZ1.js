import { p as resolveUserPath } from "./utils-CCskKJVV.js";
import { a as safeFileURLToPath, t as assertNoWindowsNetworkPath } from "./local-file-access-BFRyoFSV.js";
import { a as getDefaultMediaLocalRoots } from "./local-roots-Dz9MI8Lu.js";
import { c as resolveMediaBufferPath, s as getMediaDir } from "./store-yK49THmd.js";
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
	const inboundDir = path.resolve(getMediaDir(), "inbound");
	const resolvedPath = path.resolve(localPath);
	const rel = path.relative(inboundDir, resolvedPath);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
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
//#region src/media/local-media-access.ts
var LocalMediaAccessError = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "LocalMediaAccessError";
	}
};
function getDefaultLocalRoots() {
	return getDefaultMediaLocalRoots();
}
async function assertLocalMediaAllowed(mediaPath, localRoots) {
	if (localRoots === "any") return;
	if (await resolveInboundMediaReference(mediaPath).catch(() => null)) return;
	try {
		assertNoWindowsNetworkPath(mediaPath, "Local media path");
	} catch (err) {
		throw new LocalMediaAccessError("network-path-not-allowed", err.message, { cause: err });
	}
	const roots = localRoots ?? getDefaultLocalRoots();
	let resolved;
	try {
		resolved = await fs.realpath(mediaPath);
	} catch {
		resolved = path.resolve(mediaPath);
	}
	if (localRoots === void 0) {
		const workspaceRoot = roots.find((root) => path.basename(root) === "workspace");
		if (workspaceRoot) {
			const stateDir = path.dirname(workspaceRoot);
			const rel = path.relative(stateDir, resolved);
			if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
				if ((rel.split(path.sep)[0] ?? "").startsWith("workspace-")) throw new LocalMediaAccessError("path-not-allowed", `Local media path is not under an allowed directory: ${mediaPath}`);
			}
		}
	}
	for (const root of roots) {
		let resolvedRoot;
		try {
			resolvedRoot = await fs.realpath(root);
		} catch {
			resolvedRoot = path.resolve(root);
		}
		if (resolvedRoot === path.parse(resolvedRoot).root) throw new LocalMediaAccessError("invalid-root", `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`);
		if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) return;
	}
	throw new LocalMediaAccessError("path-not-allowed", `Local media path is not under an allowed directory: ${mediaPath}`);
}
//#endregion
export { classifyMediaReferenceSource as a, resolveMediaReferenceLocalPath as c, MediaReferenceError as i, assertLocalMediaAllowed as n, normalizeMediaReferenceSource as o, getDefaultLocalRoots as r, resolveInboundMediaReference as s, LocalMediaAccessError as t };
