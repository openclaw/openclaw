import { n as __esmMin } from "./chunk-DORXReHP.js";
//#region src/infra/prototype-keys.ts
function isBlockedObjectKey(key) {
	return BLOCKED_OBJECT_KEYS.has(key);
}
var BLOCKED_OBJECT_KEYS;
var init_prototype_keys = __esmMin((() => {
	BLOCKED_OBJECT_KEYS = new Set([
		"__proto__",
		"prototype",
		"constructor"
	]);
}));
//#endregion
//#region src/routing/account-id.ts
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
var DEFAULT_ACCOUNT_ID, VALID_ID_RE, INVALID_CHARS_RE, LEADING_DASH_RE, TRAILING_DASH_RE, ACCOUNT_ID_CACHE_MAX, normalizeAccountIdCache, normalizeOptionalAccountIdCache;
var init_account_id = __esmMin((() => {
	init_prototype_keys();
	DEFAULT_ACCOUNT_ID = "default";
	VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
	INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
	LEADING_DASH_RE = /^-+/;
	TRAILING_DASH_RE = /-+$/;
	ACCOUNT_ID_CACHE_MAX = 512;
	normalizeAccountIdCache = /* @__PURE__ */ new Map();
	normalizeOptionalAccountIdCache = /* @__PURE__ */ new Map();
}));
//#endregion
export { init_prototype_keys as a, normalizeOptionalAccountId as i, init_account_id as n, isBlockedObjectKey as o, normalizeAccountId as r, DEFAULT_ACCOUNT_ID as t };
