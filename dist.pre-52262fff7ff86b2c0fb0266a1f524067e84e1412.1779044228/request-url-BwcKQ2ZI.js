//#region src/plugin-sdk/request-url.ts
/** Extract a string URL from the common request-like inputs accepted by fetch helpers. */
function resolveRequestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (typeof input === "object" && input && "url" in input && typeof input.url === "string") return input.url;
	return "";
}
//#endregion
export { resolveRequestUrl as t };
