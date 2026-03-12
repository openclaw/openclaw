import { n as redactSensitiveText } from "./redact-Dcypez3H.js";

//#region src/infra/errors.ts
function extractErrorCode(err) {
	if (!err || typeof err !== "object") return;
	const code = err.code;
	if (typeof code === "string") return code;
	if (typeof code === "number") return String(code);
}
/**
* Type guard for NodeJS.ErrnoException (any error with a `code` property).
*/
function isErrno(err) {
	return Boolean(err && typeof err === "object" && "code" in err);
}
/**
* Check if an error has a specific errno code.
*/
function hasErrnoCode(err, code) {
	return isErrno(err) && err.code === code;
}
function formatErrorMessage(err) {
	let formatted;
	if (err instanceof Error) formatted = err.message || err.name || "Error";
	else if (typeof err === "string") formatted = err;
	else if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") formatted = String(err);
	else try {
		formatted = JSON.stringify(err);
	} catch {
		formatted = Object.prototype.toString.call(err);
	}
	return redactSensitiveText(formatted);
}
function formatUncaughtError(err) {
	if (extractErrorCode(err) === "INVALID_CONFIG") return formatErrorMessage(err);
	if (err instanceof Error) return redactSensitiveText(err.stack ?? err.message ?? err.name);
	return formatErrorMessage(err);
}

//#endregion
export { isErrno as a, hasErrnoCode as i, formatErrorMessage as n, formatUncaughtError as r, extractErrorCode as t };