import { n as redactSensitiveText } from "./redact-ey2aG4c9.js";
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
//#region src/cli/cli-utils.ts
async function withManager(params) {
	const { manager, error } = await params.getManager();
	if (!manager) {
		params.onMissing(error);
		return;
	}
	try {
		await params.run(manager);
	} finally {
		try {
			await params.close(manager);
		} catch (err) {
			params.onCloseError?.(err);
		}
	}
}
async function runCommandWithRuntime(runtime, action, onError) {
	try {
		await action();
	} catch (err) {
		if (onError) {
			onError(err);
			return;
		}
		runtime.error(String(err));
		runtime.exit(1);
	}
}
function resolveOptionFromCommand(command, key) {
	let current = command;
	while (current) {
		const opts = current.opts?.() ?? {};
		if (opts[key] !== void 0) return opts[key];
		current = current.parent ?? void 0;
	}
}
//#endregion
export { extractErrorCode as a, hasErrnoCode as c, collectErrorGraphCandidates as i, isErrno as l, runCommandWithRuntime as n, formatErrorMessage as o, withManager as r, formatUncaughtError as s, resolveOptionFromCommand as t, readErrorName as u };
