import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
//#region src/auto-reply/reply/origin-routing.ts
function resolveOriginMessageProvider(params) {
	return normalizeOptionalLowercaseString(params.originatingChannel) ?? normalizeOptionalLowercaseString(params.provider);
}
function resolveOriginMessageTo(params) {
	return params.originatingTo ?? params.to;
}
function resolveOriginAccountId(params) {
	return params.originatingAccountId ?? params.accountId;
}
//#endregion
export { resolveOriginMessageProvider as n, resolveOriginMessageTo as r, resolveOriginAccountId as t };
