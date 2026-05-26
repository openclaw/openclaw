//#region src/infra/net/proxy/active-proxy-state.ts
let activeProxyUrl;
let activeProxyLoopbackMode;
let activeProxyTlsOptions;
let activeProxyRegistrationCount = 0;
function parseActiveManagedProxyLoopbackMode(value) {
	if (value === "gateway-only" || value === "proxy" || value === "block") return value;
}
function readInheritedActiveManagedProxyLoopbackMode() {
	if (process.env["OPENCLAW_PROXY_ACTIVE"] !== "1") return;
	return parseActiveManagedProxyLoopbackMode(process.env["OPENCLAW_PROXY_LOOPBACK_MODE"]) ?? "gateway-only";
}
function registerActiveManagedProxyUrl(proxyUrl, options = "gateway-only") {
	const normalizedProxyUrl = new URL(proxyUrl.href);
	const loopbackMode = typeof options === "string" ? options : options.loopbackMode ?? "gateway-only";
	const proxyTls = typeof options === "string" ? void 0 : options.proxyTls;
	if (activeProxyUrl !== void 0) {
		if (activeProxyUrl.href !== normalizedProxyUrl.href) throw new Error("proxy: cannot activate a managed proxy while another proxy is active; stop the current proxy before changing proxy.proxyUrl.");
		if (activeProxyLoopbackMode !== loopbackMode) throw new Error("proxy: cannot activate a managed proxy with a different proxy.loopbackMode while another proxy is active; stop the current proxy before changing proxy.loopbackMode.");
		if (!areProxyTlsOptionsEqual(activeProxyTlsOptions, proxyTls)) throw new Error("proxy: cannot activate a managed proxy with different proxy TLS options while another proxy is active; stop the current proxy before changing proxy.tls.");
		activeProxyRegistrationCount += 1;
		return {
			proxyUrl: activeProxyUrl,
			loopbackMode,
			proxyTls: activeProxyTlsOptions,
			stopped: false
		};
	}
	activeProxyUrl = normalizedProxyUrl;
	activeProxyLoopbackMode = loopbackMode;
	activeProxyTlsOptions = proxyTls;
	activeProxyRegistrationCount = 1;
	return {
		proxyUrl: activeProxyUrl,
		loopbackMode,
		proxyTls,
		stopped: false
	};
}
function areProxyTlsOptionsEqual(left, right) {
	return left?.ca === right?.ca;
}
function stopActiveManagedProxyRegistration(registration) {
	if (registration.stopped) return;
	registration.stopped = true;
	if (activeProxyUrl?.href !== registration.proxyUrl.href) return;
	activeProxyRegistrationCount = Math.max(0, activeProxyRegistrationCount - 1);
	if (activeProxyRegistrationCount === 0) {
		activeProxyUrl = void 0;
		activeProxyLoopbackMode = void 0;
		activeProxyTlsOptions = void 0;
	}
}
function getActiveManagedProxyLoopbackMode() {
	return activeProxyLoopbackMode ?? readInheritedActiveManagedProxyLoopbackMode();
}
function getActiveManagedProxyUrl() {
	return activeProxyUrl;
}
function getActiveManagedProxyTlsOptions() {
	return activeProxyTlsOptions;
}
//#endregion
export { stopActiveManagedProxyRegistration as a, registerActiveManagedProxyUrl as i, getActiveManagedProxyTlsOptions as n, getActiveManagedProxyUrl as r, getActiveManagedProxyLoopbackMode as t };
