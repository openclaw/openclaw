import { p as FsSafeError } from "./path-B5B-_oAT.js";
//#region node_modules/@openclaw/fs-safe/dist/safe-path-segment.js
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const SAFE_DOT_PREFIX_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
function isSafePathSegment(segment, options = {}) {
	return segment !== "" && segment !== "." && segment !== ".." && !segment.includes("/") && !segment.includes("\\") && !segment.includes("\0") && (options.allowDotPrefix === true || !segment.startsWith(".")) && (options.allowDotPrefix === true ? SAFE_DOT_PREFIX_PATH_SEGMENT_PATTERN.test(segment) : SAFE_PATH_SEGMENT_PATTERN.test(segment));
}
function assertSafePathSegment(segment, options = {}) {
	if (!isSafePathSegment(segment, options)) throw new FsSafeError("invalid-path", `${options.label ?? "path segment"} must be a safe path segment`);
	return segment;
}
function assertSafePathPrefix(prefix, options = {}) {
	if (prefix.includes("/") || prefix.includes("\\") || prefix.includes("\0")) return assertSafePathSegment(prefix, {
		allowDotPrefix: true,
		...options,
		label: options.label ?? "path prefix"
	});
	return assertSafePathSegment(prefix.replace(/[^A-Za-z0-9._-]+/g, "-"), {
		allowDotPrefix: true,
		...options,
		label: options.label ?? "path prefix"
	});
}
//#endregion
export { assertSafePathSegment as n, assertSafePathPrefix as t };
