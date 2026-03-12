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
	return normalizeCanonicalAccountId(trimmed) || DEFAULT_ACCOUNT_ID;
}

//#endregion
export { DEFAULT_ACCOUNT_ID, normalizeAccountId };