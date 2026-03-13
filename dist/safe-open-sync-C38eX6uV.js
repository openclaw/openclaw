import fs from "node:fs";
//#region src/infra/prototype-keys.ts
const BLOCKED_OBJECT_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function isBlockedObjectKey(key) {
	return BLOCKED_OBJECT_KEYS.has(key);
}
//#endregion
//#region src/routing/account-id.ts
const DEFAULT_ACCOUNT_ID = "default";
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
const ACCOUNT_ID_CACHE_MAX = 512;
const normalizeAccountIdCache = /* @__PURE__ */ new Map();
const normalizeOptionalAccountIdCache = /* @__PURE__ */ new Map();
function canonicalizeAccountId(value) {
	if (VALID_ID_RE.test(value)) return value.toLowerCase();
	return value.toLowerCase().replace(INVALID_CHARS_RE, "-").replace(LEADING_DASH_RE, "").replace(TRAILING_DASH_RE, "").slice(0, 64);
}
function normalizeCanonicalAccountId(value) {
	const canonical = canonicalizeAccountId(value);
	if (!canonical || isBlockedObjectKey(canonical)) return;
	return canonical;
}
function normalizeAccountId(value) {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return DEFAULT_ACCOUNT_ID;
	const cached = normalizeAccountIdCache.get(trimmed);
	if (cached) return cached;
	const normalized = normalizeCanonicalAccountId(trimmed) || "default";
	setNormalizeCache(normalizeAccountIdCache, trimmed, normalized);
	return normalized;
}
function normalizeOptionalAccountId(value) {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return;
	if (normalizeOptionalAccountIdCache.has(trimmed)) return normalizeOptionalAccountIdCache.get(trimmed);
	const normalized = normalizeCanonicalAccountId(trimmed) || void 0;
	setNormalizeCache(normalizeOptionalAccountIdCache, trimmed, normalized);
	return normalized;
}
function setNormalizeCache(cache, key, value) {
	cache.set(key, value);
	if (cache.size <= ACCOUNT_ID_CACHE_MAX) return;
	const oldest = cache.keys().next();
	if (!oldest.done) cache.delete(oldest.value);
}
//#endregion
//#region src/infra/file-identity.ts
function isZero(value) {
	return value === 0 || value === 0n;
}
function sameFileIdentity$1(left, right, platform = process.platform) {
	if (left.ino !== right.ino) return false;
	if (left.dev === right.dev) return true;
	return platform === "win32" && (isZero(left.dev) || isZero(right.dev));
}
//#endregion
//#region src/infra/safe-open-sync.ts
function isExpectedPathError(error) {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}
function sameFileIdentity(left, right) {
	return sameFileIdentity$1(left, right);
}
function openVerifiedFileSync(params) {
	const ioFs = params.ioFs ?? fs;
	const allowedType = params.allowedType ?? "file";
	const openReadFlags = ioFs.constants.O_RDONLY | (typeof ioFs.constants.O_NOFOLLOW === "number" ? ioFs.constants.O_NOFOLLOW : 0);
	let fd = null;
	try {
		if (params.rejectPathSymlink) {
			if (ioFs.lstatSync(params.filePath).isSymbolicLink()) return {
				ok: false,
				reason: "validation"
			};
		}
		const realPath = params.resolvedPath ?? ioFs.realpathSync(params.filePath);
		const preOpenStat = ioFs.lstatSync(realPath);
		if (!isAllowedType(preOpenStat, allowedType)) return {
			ok: false,
			reason: "validation"
		};
		if (params.rejectHardlinks && preOpenStat.isFile() && preOpenStat.nlink > 1) return {
			ok: false,
			reason: "validation"
		};
		if (params.maxBytes !== void 0 && preOpenStat.isFile() && preOpenStat.size > params.maxBytes) return {
			ok: false,
			reason: "validation"
		};
		fd = ioFs.openSync(realPath, openReadFlags);
		const openedStat = ioFs.fstatSync(fd);
		if (!isAllowedType(openedStat, allowedType)) return {
			ok: false,
			reason: "validation"
		};
		if (params.rejectHardlinks && openedStat.isFile() && openedStat.nlink > 1) return {
			ok: false,
			reason: "validation"
		};
		if (params.maxBytes !== void 0 && openedStat.isFile() && openedStat.size > params.maxBytes) return {
			ok: false,
			reason: "validation"
		};
		if (!sameFileIdentity(preOpenStat, openedStat)) return {
			ok: false,
			reason: "validation"
		};
		const opened = {
			ok: true,
			path: realPath,
			fd,
			stat: openedStat
		};
		fd = null;
		return opened;
	} catch (error) {
		if (isExpectedPathError(error)) return {
			ok: false,
			reason: "path",
			error
		};
		return {
			ok: false,
			reason: "io",
			error
		};
	} finally {
		if (fd !== null) ioFs.closeSync(fd);
	}
}
function isAllowedType(stat, allowedType) {
	if (allowedType === "directory") return stat.isDirectory();
	return stat.isFile();
}
//#endregion
export { normalizeOptionalAccountId as a, normalizeAccountId as i, sameFileIdentity$1 as n, isBlockedObjectKey as o, DEFAULT_ACCOUNT_ID as r, openVerifiedFileSync as t };
