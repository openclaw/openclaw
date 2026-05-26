import { t as normalizeLowercaseStringOrEmpty } from "./string-coerce-6TL5VVOL.js";
import fs from "node:fs";
import path from "node:path";
//#region node_modules/@openclaw/fs-safe/dist/errors.js
const OPERATIONAL_CODES = new Set([
	"helper-failed",
	"helper-unavailable",
	"permission-unverified",
	"timeout",
	"unsupported-platform"
]);
function categorizeFsSafeError(code) {
	return OPERATIONAL_CODES.has(code) ? "operational" : "policy";
}
var FsSafeError = class extends Error {
	code;
	category;
	constructor(code, message, options = {}) {
		super(message, options);
		this.name = "FsSafeError";
		this.code = code;
		this.category = categorizeFsSafeError(code);
	}
};
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/path.js
const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR"]);
const SYMLINK_OPEN_CODES = new Set([
	"ELOOP",
	"EINVAL",
	"ENOTSUP"
]);
const POSIX_SEPARATOR_CHAR_CODE = 47;
function normalizeWindowsPathForComparison(input) {
	let normalized = path.win32.normalize(input);
	if (normalized.startsWith("\\\\?\\")) {
		normalized = normalized.slice(4);
		if (normalized.toUpperCase().startsWith("UNC\\")) normalized = `\\\\${normalized.slice(4)}`;
	}
	return normalizeLowercaseStringOrEmpty(normalized.replaceAll("/", "\\"));
}
function isNodeError(value) {
	return Boolean(value && typeof value === "object" && "code" in value);
}
function hasNodeErrorCode(value, code) {
	return isNodeError(value) && value.code === code;
}
function assertNoNulPathInput(filePath, message = "path contains a NUL byte") {
	if (filePath.includes("\0")) throw new FsSafeError("invalid-path", message);
}
function isNotFoundPathError(value) {
	return isNodeError(value) && typeof value.code === "string" && NOT_FOUND_CODES.has(value.code);
}
function isSymlinkOpenError(value) {
	return isNodeError(value) && typeof value.code === "string" && SYMLINK_OPEN_CODES.has(value.code);
}
function isPathInside(root, target) {
	if (process.platform === "win32") {
		const rootForCompare = normalizeWindowsPathForComparison(path.win32.resolve(root));
		const targetForCompare = normalizeWindowsPathForComparison(path.win32.resolve(target));
		const relative = path.win32.relative(rootForCompare, targetForCompare);
		const firstSegment = relative.split(path.win32.sep)[0];
		return relative === "" || firstSegment !== ".." && !path.win32.isAbsolute(relative);
	}
	if (root.length > 0 && root.charCodeAt(0) === POSIX_SEPARATOR_CHAR_CODE && target.length >= root.length && target.charCodeAt(0) === POSIX_SEPARATOR_CHAR_CODE && !target.includes("/..") && (target === root || target.startsWith(root) && target.charCodeAt(root.length) === POSIX_SEPARATOR_CHAR_CODE)) return true;
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	const relative = path.relative(resolvedRoot, resolvedTarget);
	const firstSegment = relative.split(path.posix.sep)[0];
	return relative === "" || firstSegment !== ".." && !path.isAbsolute(relative);
}
function isPathRelativeEscape(relativePath) {
	return relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}
function resolveSafeBaseDir(rootDir) {
	const resolved = path.resolve(rootDir);
	return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}
function isWithinDir(rootDir, targetPath) {
	return isPathInside(rootDir, targetPath);
}
function safeRealpathSync(targetPath, cache) {
	const cached = cache?.get(targetPath);
	if (cached) return cached;
	try {
		const resolved = fs.realpathSync(targetPath);
		cache?.set(targetPath, resolved);
		cache?.set(resolved, resolved);
		return resolved;
	} catch {
		return null;
	}
}
function isPathInsideWithRealpath(basePath, candidatePath, opts) {
	if (!isPathInside(basePath, candidatePath)) return false;
	const baseReal = safeRealpathSync(basePath, opts?.cache);
	const candidateReal = safeRealpathSync(candidatePath, opts?.cache);
	if (!baseReal || !candidateReal) return opts?.requireRealpath === false;
	return isPathInside(baseReal, candidateReal);
}
function safeStatSync(targetPath) {
	try {
		return fs.statSync(targetPath);
	} catch {
		return null;
	}
}
function splitSafeRelativePath(relativePath) {
	if (relativePath.length === 0 || relativePath === ".") return [];
	assertNoNulPathInput(relativePath, "relative path contains a NUL byte");
	if (relativePath.includes("\\")) throw new FsSafeError("invalid-path", "relative path must use forward slashes");
	if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || relativePath.startsWith("//")) throw new FsSafeError("invalid-path", "relative path must not be absolute");
	const segments = relativePath.split("/").filter((segment) => segment.length > 0 && segment !== ".");
	for (const segment of segments) if (segment === "..") throw new FsSafeError("invalid-path", "relative path must not contain '..'");
	return segments;
}
function resolveSafeRelativePath(rootDir, relativePath) {
	const root = path.resolve(rootDir);
	const target = path.resolve(root, ...splitSafeRelativePath(relativePath));
	if (!isPathInside(root, target)) throw new FsSafeError("outside-workspace", "relative path escapes root");
	return target;
}
//#endregion
export { isPathInsideWithRealpath as a, isWithinDir as c, resolveSafeRelativePath as d, safeRealpathSync as f, isPathInside as i, normalizeWindowsPathForComparison as l, FsSafeError as m, hasNodeErrorCode as n, isPathRelativeEscape as o, safeStatSync as p, isNotFoundPathError as r, isSymlinkOpenError as s, assertNoNulPathInput as t, resolveSafeBaseDir as u };
