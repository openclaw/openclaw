//#region src/infra/net/proxy/active-proxy-state.ts
let activeProxyUrl;
let activeProxyLoopbackMode;
let activeProxyRegistrationCount = 0;
function parseActiveManagedProxyLoopbackMode(value) {
	if (value === "gateway-only" || value === "proxy" || value === "block") return value;
}
function readInheritedActiveManagedProxyLoopbackMode() {
	if (process.env["OPENCLAW_PROXY_ACTIVE"] !== "1") return;
	return parseActiveManagedProxyLoopbackMode(process.env["OPENCLAW_PROXY_LOOPBACK_MODE"]) ?? "gateway-only";
}
function registerActiveManagedProxyUrl(proxyUrl, loopbackMode = "gateway-only") {
	const normalizedProxyUrl = new URL(proxyUrl.href);
	if (activeProxyUrl !== void 0) {
		if (activeProxyUrl.href !== normalizedProxyUrl.href) throw new Error("proxy: cannot activate a managed proxy while another proxy is active; stop the current proxy before changing proxy.proxyUrl.");
		if (activeProxyLoopbackMode !== loopbackMode) throw new Error("proxy: cannot activate a managed proxy with a different proxy.loopbackMode while another proxy is active; stop the current proxy before changing proxy.loopbackMode.");
		activeProxyRegistrationCount += 1;
		return {
			proxyUrl: activeProxyUrl,
			loopbackMode,
			stopped: false
		};
	}
	activeProxyUrl = normalizedProxyUrl;
	activeProxyLoopbackMode = loopbackMode;
	activeProxyRegistrationCount = 1;
	return {
		proxyUrl: activeProxyUrl,
		loopbackMode,
		stopped: false
	};
}
function stopActiveManagedProxyRegistration(registration) {
	if (registration.stopped) return;
	registration.stopped = true;
	if (activeProxyUrl?.href !== registration.proxyUrl.href) return;
	activeProxyRegistrationCount = Math.max(0, activeProxyRegistrationCount - 1);
	if (activeProxyRegistrationCount === 0) {
		activeProxyUrl = void 0;
		activeProxyLoopbackMode = void 0;
	}
}
function getActiveManagedProxyLoopbackMode() {
	return activeProxyLoopbackMode ?? readInheritedActiveManagedProxyLoopbackMode();
}
function getActiveManagedProxyUrl() {
	return activeProxyUrl;
}
//#endregion
export { stopActiveManagedProxyRegistration as i, getActiveManagedProxyUrl as n, registerActiveManagedProxyUrl as r, getActiveManagedProxyLoopbackMode as t };
