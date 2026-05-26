import path from "node:path";
//#region src/media/inbound-path-policy.ts
const WILDCARD_SEGMENT = "*";
const WINDOWS_DRIVE_ABS_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:$/;
function normalizePosixAbsolutePath(value) {
	const trimmed = value.trim();
	if (!trimmed || trimmed.includes("\0")) return;
	const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/"));
	if (!(normalized.startsWith("/") || WINDOWS_DRIVE_ABS_RE.test(normalized)) || normalized === "/") return;
	const withoutTrailingSlash = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	if (WINDOWS_DRIVE_ROOT_RE.test(withoutTrailingSlash)) return;
	return withoutTrailingSlash;
}
function splitPathSegments(value) {
	return value.split("/").filter(Boolean);
}
function matchesRootPattern(params) {
	const candidateSegments = splitPathSegments(params.candidatePath);
	const rootSegments = splitPathSegments(params.rootPattern);
	if (candidateSegments.length < rootSegments.length) return false;
	for (let idx = 0; idx < rootSegments.length; idx += 1) {
		const expected = rootSegments[idx];
		const actual = candidateSegments[idx];
		if (expected === WILDCARD_SEGMENT) continue;
		if (expected !== actual) return false;
	}
	return true;
}
function isValidInboundPathRootPattern(value) {
	const normalized = normalizePosixAbsolutePath(value);
	if (!normalized) return false;
	const segments = splitPathSegments(normalized);
	if (segments.length === 0) return false;
	return segments.every((segment) => segment === WILDCARD_SEGMENT || !segment.includes("*"));
}
function normalizeInboundPathRoots(roots) {
	const normalized = [];
	const seen = /* @__PURE__ */ new Set();
	for (const root of roots ?? []) {
		if (typeof root !== "string") continue;
		if (!isValidInboundPathRootPattern(root)) continue;
		const candidate = normalizePosixAbsolutePath(root);
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		normalized.push(candidate);
	}
	return normalized;
}
function mergeInboundPathRoots(...rootsLists) {
	const merged = [];
	const seen = /* @__PURE__ */ new Set();
	for (const roots of rootsLists) {
		const normalized = normalizeInboundPathRoots(roots);
		for (const root of normalized) {
			if (seen.has(root)) continue;
			seen.add(root);
			merged.push(root);
		}
	}
	return merged;
}
function isInboundPathAllowed(params) {
	const candidatePath = normalizePosixAbsolutePath(params.filePath);
	if (!candidatePath) return false;
	const roots = normalizeInboundPathRoots(params.roots);
	const effectiveRoots = roots.length > 0 ? roots : normalizeInboundPathRoots(params.fallbackRoots ?? void 0);
	if (effectiveRoots.length === 0) return false;
	return effectiveRoots.some((rootPattern) => matchesRootPattern({
		candidatePath,
		rootPattern
	}));
}
//#endregion
export { normalizeInboundPathRoots as i, isValidInboundPathRootPattern as n, mergeInboundPathRoots as r, isInboundPathAllowed as t };
