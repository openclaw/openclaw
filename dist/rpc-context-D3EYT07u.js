import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/signal/src/rpc-context.ts
function resolveSignalRpcContext(opts, accountInfo) {
	const hasBaseUrl = Boolean(normalizeOptionalString(opts.baseUrl));
	const hasAccount = Boolean(normalizeOptionalString(opts.account));
	if ((!hasBaseUrl || !hasAccount) && !accountInfo) throw new Error("Signal account config is required when baseUrl or account is missing");
	const resolvedAccount = accountInfo;
	const baseUrl = normalizeOptionalString(opts.baseUrl) ?? resolvedAccount?.baseUrl;
	if (!baseUrl) throw new Error("Signal base URL is required");
	return {
		baseUrl,
		account: normalizeOptionalString(opts.account) ?? normalizeOptionalString(resolvedAccount?.config.account)
	};
}
//#endregion
export { resolveSignalRpcContext as t };
