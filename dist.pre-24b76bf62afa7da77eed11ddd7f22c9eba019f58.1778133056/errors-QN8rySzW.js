import { i as redactSensitiveText } from "./redact-1fZUZMlV.js";
//#region src/infra/errors.ts
function extractErrorCode(err) {
	if (!err || typeof err !== "object") return;
	const code = err.code;
	if (typeof code === "string") return code;
	if (typeof code === "number") return String(code);
}
function readErrorName(err) {
	if (!err || typeof err !== "object") return "";
	const name = err.name;
	return typeof name === "string" ? name : "";
}
function collectErrorGraphCandidates(err, resolveNested) {
	const queue = [err];
	const seen = /* @__PURE__ */ new Set();
	const candidates = [];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current == null || seen.has(current)) continue;
		seen.add(current);
		candidates.push(current);
		if (!current || typeof current !== "object" || !resolveNested) continue;
		for (const nested of resolveNested(current)) if (nested != null && !seen.has(nested)) queue.push(nested);
	}
	return candidates;
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
	if (err instanceof Error) {
		formatted = err.message || err.name || "Error";
		let cause = err.cause;
		const seen = new Set([err]);
		while (cause && !seen.has(cause)) {
			seen.add(cause);
			if (cause instanceof Error) {
				if (cause.message) formatted += ` | ${cause.message}`;
				cause = cause.cause;
			} else if (typeof cause === "string") {
				formatted += ` | ${cause}`;
				break;
			} else break;
		}
	} else if (typeof err === "string") formatted = err;
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
function detectErrorKind(err) {
	if (err === void 0) return;
	const message = formatErrorMessage(err).toLowerCase();
	const code = extractErrorCode(err)?.toLowerCase();
	if (message.includes("refusal") || message.includes("content_filter") || message.includes("sensitive") || message.includes("unhandled stop reason: refusal_policy")) return "refusal";
	if (message.includes("timeout") || code === "etimedout" || code === "timeout") return "timeout";
	if (message.includes("rate limit") || message.includes("too many requests") || message.includes("429") || code === "429") return "rate_limit";
	if (message.includes("context length") || message.includes("too many tokens") || message.includes("token limit") || message.includes("context_window")) return "context_length";
}
//#endregion
export { formatUncaughtError as a, readErrorName as c, formatErrorMessage as i, detectErrorKind as n, hasErrnoCode as o, extractErrorCode as r, isErrno as s, collectErrorGraphCandidates as t };
