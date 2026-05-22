import { createRequire } from "node:module";
//#region src/infra/net/undici-runtime.ts
const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const HTTP1_ONLY_DISPATCHER_OPTIONS = Object.freeze({ allowH2: false });
function isObjectRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isUndiciRuntimeDeps(value) {
	return typeof value === "object" && value !== null && typeof value.Agent === "function" && typeof value.EnvHttpProxyAgent === "function" && typeof value.ProxyAgent === "function" && typeof value.fetch === "function";
}
function loadUndiciRuntimeDeps() {
	const override = globalThis[TEST_UNDICI_RUNTIME_DEPS_KEY];
	if (isUndiciRuntimeDeps(override)) return override;
	const undici = createRequire(import.meta.url)("undici");
	return {
		Agent: undici.Agent,
		EnvHttpProxyAgent: undici.EnvHttpProxyAgent,
		FormData: undici.FormData,
		ProxyAgent: undici.ProxyAgent,
		fetch: undici.fetch
	};
}
function withHttp1OnlyDispatcherOptions(options, timeoutMs) {
	const base = {};
	if (options) Object.assign(base, options);
	Object.assign(base, HTTP1_ONLY_DISPATCHER_OPTIONS);
	if (timeoutMs !== void 0 && Number.isFinite(timeoutMs) && timeoutMs > 0) {
		const normalizedTimeoutMs = Math.floor(timeoutMs);
		const baseRecord = base;
		baseRecord.bodyTimeout = normalizedTimeoutMs;
		baseRecord.headersTimeout = normalizedTimeoutMs;
		if (typeof baseRecord.connect !== "function") baseRecord.connect = {
			...isObjectRecord(baseRecord.connect) ? baseRecord.connect : {},
			timeout: normalizedTimeoutMs
		};
	}
	return base;
}
function createHttp1Agent(options, timeoutMs) {
	const { Agent } = loadUndiciRuntimeDeps();
	return new Agent(withHttp1OnlyDispatcherOptions(options, timeoutMs));
}
function createHttp1EnvHttpProxyAgent(options, timeoutMs) {
	const { EnvHttpProxyAgent } = loadUndiciRuntimeDeps();
	return new EnvHttpProxyAgent(withHttp1OnlyDispatcherOptions(options, timeoutMs));
}
function createHttp1ProxyAgent(options, timeoutMs) {
	const { ProxyAgent } = loadUndiciRuntimeDeps();
	return new ProxyAgent(withHttp1OnlyDispatcherOptions(typeof options === "string" || options instanceof URL ? { uri: options.toString() } : { ...options }, timeoutMs));
}
//#endregion
export { loadUndiciRuntimeDeps as i, createHttp1EnvHttpProxyAgent as n, createHttp1ProxyAgent as r, createHttp1Agent as t };
