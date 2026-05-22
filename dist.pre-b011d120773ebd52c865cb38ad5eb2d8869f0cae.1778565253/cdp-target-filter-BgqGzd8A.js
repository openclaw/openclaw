//#region extensions/browser/src/browser/cdp-target-filter.ts
const BROWSER_INTERNAL_TARGET_URL_PREFIXES = [
	"chrome://",
	"chrome-untrusted://",
	"devtools://",
	"edge://",
	"brave://",
	"vivaldi://",
	"opera://"
];
function isBrowserInternalTargetUrl(url) {
	const normalized = url?.trim().toLowerCase() ?? "";
	return BROWSER_INTERNAL_TARGET_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
function isSelectableCdpBrowserTarget(target) {
	return !isBrowserInternalTargetUrl(target.url);
}
//#endregion
export { isSelectableCdpBrowserTarget as t };
