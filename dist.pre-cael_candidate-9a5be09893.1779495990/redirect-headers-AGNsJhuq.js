import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as normalizeHeadersInitForFetch } from "./fetch-headers-D18pVzIl.js";
//#region src/infra/net/redirect-headers.ts
const CROSS_ORIGIN_REDIRECT_SAFE_HEADERS = new Set([
	"accept",
	"accept-encoding",
	"accept-language",
	"cache-control",
	"content-language",
	"content-type",
	"if-match",
	"if-modified-since",
	"if-none-match",
	"if-unmodified-since",
	"pragma",
	"range",
	"user-agent"
]);
function retainSafeHeadersForCrossOriginRedirect(headers) {
	if (!headers) return headers;
	const incoming = new Headers(normalizeHeadersInitForFetch(headers));
	const safeHeaders = {};
	for (const [key, value] of incoming.entries()) if (CROSS_ORIGIN_REDIRECT_SAFE_HEADERS.has(normalizeLowercaseStringOrEmpty(key))) safeHeaders[key] = value;
	return safeHeaders;
}
//#endregion
export { retainSafeHeadersForCrossOriginRedirect as t };
