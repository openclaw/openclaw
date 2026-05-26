//#region src/infra/approval-display-paths.ts
function formatApprovalDisplayPath(value) {
	const normalized = value.trim();
	if (!normalized || hasRelativePathSegment(normalized)) return normalized;
	const unixHomeMatch = normalized.match(/^\/(?:home|Users)\/([^/]+)(.*)$/);
	if (unixHomeMatch && isSafeHomeSegment(unixHomeMatch[1])) return compactHomeSuffix(unixHomeMatch[2] ?? "");
	const windowsHomeMatch = normalized.match(/^[A-Za-z]:[\\/]Users[\\/]([^\\/]+)(.*)$/i);
	if (windowsHomeMatch && isSafeHomeSegment(windowsHomeMatch[1])) return compactHomeSuffix(windowsHomeMatch[2] ?? "");
	return normalized;
}
function compactHomeSuffix(suffix) {
	return `~${suffix.replace(/\\/g, "/")}`;
}
function isSafeHomeSegment(segment) {
	return segment !== void 0 && segment !== "." && segment !== "..";
}
function hasRelativePathSegment(value) {
	return /(^|[\\/])\.{1,2}(?=[\\/]|$)/.test(value);
}
//#endregion
export { formatApprovalDisplayPath as t };
