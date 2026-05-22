//#region src/infra/net/proxy/active-proxy-state.ts
let activeProxyUrl;
let activeProxyRegistrationCount = 0;
function registerActiveManagedProxyUrl(proxyUrl) {
	const normalizedProxyUrl = new URL(proxyUrl.href);
	if (activeProxyUrl !== void 0) {
		if (activeProxyUrl.href !== normalizedProxyUrl.href) throw new Error("proxy: cannot activate a managed proxy while another proxy is active; stop the current proxy before changing proxy.proxyUrl.");
		activeProxyRegistrationCount += 1;
		return {
			proxyUrl: activeProxyUrl,
			stopped: false
		};
	}
	activeProxyUrl = normalizedProxyUrl;
	activeProxyRegistrationCount = 1;
	return {
		proxyUrl: activeProxyUrl,
		stopped: false
	};
}
function stopActiveManagedProxyRegistration(registration) {
	if (registration.stopped) return;
	registration.stopped = true;
	if (activeProxyUrl?.href !== registration.proxyUrl.href) return;
	activeProxyRegistrationCount = Math.max(0, activeProxyRegistrationCount - 1);
	if (activeProxyRegistrationCount === 0) activeProxyUrl = void 0;
}
function getActiveManagedProxyUrl() {
	return activeProxyUrl;
}
//#endregion
export { registerActiveManagedProxyUrl as n, stopActiveManagedProxyRegistration as r, getActiveManagedProxyUrl as t };
