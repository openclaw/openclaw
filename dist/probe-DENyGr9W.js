import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import "./error-runtime-BnVeBNYa.js";
import { n as signalRpcRequest, t as signalCheck } from "./client-adapter-ByMi5D37.js";
//#region extensions/signal/src/probe.ts
function parseSignalVersion(value) {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "object" && value !== null) {
		const version = value.version;
		if (typeof version === "string" && version.trim()) return version.trim();
	}
	return null;
}
async function probeSignal(baseUrl, timeoutMs, options = {}) {
	const started = Date.now();
	const result = {
		ok: false,
		status: null,
		error: null,
		elapsedMs: 0,
		version: null
	};
	const apiMode = options.apiMode ?? "native";
	const check = await signalCheck(baseUrl, timeoutMs, { apiMode });
	if (!check.ok) return {
		...result,
		status: check.status ?? null,
		error: check.error ?? "unreachable",
		elapsedMs: Date.now() - started
	};
	try {
		result.version = parseSignalVersion(await signalRpcRequest("version", void 0, {
			baseUrl,
			timeoutMs,
			apiMode
		}));
	} catch (err) {
		result.error = formatErrorMessage(err);
	}
	return {
		...result,
		ok: true,
		status: check.status ?? null,
		elapsedMs: Date.now() - started
	};
}
//#endregion
export { probeSignal as t };
