import { a as logWarn, r as logInfo } from "./logger-0o2znY2U.js";
import { f as isLoopbackIpAddress } from "./ip-WAe3-2zT.js";
import { a as stopActiveManagedProxyRegistration, i as registerActiveManagedProxyUrl, r as getActiveManagedProxyUrl, t as getActiveManagedProxyLoopbackMode } from "./active-proxy-state-BBaqWhZo.js";
import { a as loadManagedProxyTlsOptionsSync, i as loadManagedProxyTlsOptions, o as resolveManagedProxyCaFileForUrl } from "./managed-proxy-undici-CxE3Ud0o.js";
import { a as forceResetGlobalDispatcher } from "./undici-global-dispatcher-B3DjrQKu.js";
import { installGlobalProxy } from "@openclaw/proxyline";
//#region src/infra/net/proxy/proxy-lifecycle.ts
/**
* High-level lifecycle management for OpenClaw's operator-managed network
* proxy routing.
*
* OpenClaw does not spawn or configure the filtering proxy. When enabled, it
* routes process-wide HTTP clients through the configured forward proxy URL and
* restores the previous process state on shutdown.
*/
const PROXY_ENV_KEYS = [
	"http_proxy",
	"https_proxy",
	"HTTP_PROXY",
	"HTTPS_PROXY"
];
const NO_PROXY_ENV_KEYS = ["no_proxy", "NO_PROXY"];
const PROXY_ACTIVE_KEYS = [
	"OPENCLAW_PROXY_ACTIVE",
	"OPENCLAW_PROXY_LOOPBACK_MODE",
	"OPENCLAW_PROXY_CA_FILE"
];
const ALL_PROXY_ENV_KEYS = [
	...PROXY_ENV_KEYS,
	...NO_PROXY_ENV_KEYS,
	...PROXY_ACTIVE_KEYS
];
let baseProxyEnvSnapshot = null;
let proxylineHandle = null;
const MANAGED_PROXY_UNDICI_OPTIONS = Object.freeze({ allowH2: false });
function captureProxyEnv() {
	return {
		http_proxy: process.env["http_proxy"],
		https_proxy: process.env["https_proxy"],
		HTTP_PROXY: process.env["HTTP_PROXY"],
		HTTPS_PROXY: process.env["HTTPS_PROXY"],
		no_proxy: process.env["no_proxy"],
		NO_PROXY: process.env["NO_PROXY"],
		OPENCLAW_PROXY_ACTIVE: process.env["OPENCLAW_PROXY_ACTIVE"],
		OPENCLAW_PROXY_LOOPBACK_MODE: process.env["OPENCLAW_PROXY_LOOPBACK_MODE"],
		OPENCLAW_PROXY_CA_FILE: process.env["OPENCLAW_PROXY_CA_FILE"]
	};
}
function injectProxyEnv(proxyUrl, loopbackMode, proxyCaFile) {
	const snapshot = captureProxyEnv();
	applyProxyEnv(proxyUrl, loopbackMode, proxyCaFile);
	return snapshot;
}
function applyProxyEnv(proxyUrl, loopbackMode, proxyCaFile) {
	for (const key of PROXY_ENV_KEYS) process.env[key] = proxyUrl;
	process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
	process.env["OPENCLAW_PROXY_LOOPBACK_MODE"] = loopbackMode;
	if (proxyCaFile) process.env["OPENCLAW_PROXY_CA_FILE"] = proxyCaFile;
	else delete process.env["OPENCLAW_PROXY_CA_FILE"];
	for (const key of NO_PROXY_ENV_KEYS) process.env[key] = "";
}
function restoreProxyEnv(snapshot) {
	for (const key of ALL_PROXY_ENV_KEYS) {
		const value = snapshot[key];
		if (value === void 0) delete process.env[key];
		else process.env[key] = value;
	}
}
function restoreInactiveProxyRuntime(snapshot) {
	try {
		proxylineHandle?.stop();
	} catch (err) {
		logWarn(`proxy: failed to stop Proxyline: ${String(err)}`);
	}
	proxylineHandle = null;
	restoreProxyEnv(snapshot);
	forceResetGlobalDispatcher();
	ensureInheritedManagedProxyRoutingActive();
}
function restoreAfterFailedProxyActivation(restoreSnapshot) {
	restoreInactiveProxyRuntime(restoreSnapshot);
	baseProxyEnvSnapshot = null;
}
function stopActiveProxyRegistration(registration) {
	if (registration.stopped) return;
	stopActiveManagedProxyRegistration(registration);
	if (getActiveManagedProxyUrl()) return;
	const restoreSnapshot = baseProxyEnvSnapshot ?? captureProxyEnv();
	baseProxyEnvSnapshot = null;
	restoreInactiveProxyRuntime(restoreSnapshot);
}
function isSupportedProxyUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}
function resolveProxyUrl(config) {
	const candidate = config?.proxyUrl?.trim() || process.env["OPENCLAW_PROXY_URL"]?.trim();
	if (!candidate) throw new Error("proxy: enabled but no HTTP proxy URL is configured; set proxy.proxyUrl or OPENCLAW_PROXY_URL to an http:// or https:// forward proxy.");
	if (!isSupportedProxyUrl(candidate)) throw new Error("proxy: enabled but proxy URL is invalid; set proxy.proxyUrl or OPENCLAW_PROXY_URL to an http:// or https:// forward proxy.");
	return candidate;
}
function redactProxyUrlForLog(value) {
	try {
		return new URL(value).origin;
	} catch {
		return "<invalid proxy URL>";
	}
}
function ensureInheritedManagedProxyRoutingActive() {
	if (process.env["OPENCLAW_PROXY_ACTIVE"] !== "1") return;
	const proxyUrl = process.env["HTTP_PROXY"];
	if (!proxyUrl || !isSupportedProxyUrl(proxyUrl)) return;
	const proxyTls = loadManagedProxyTlsOptionsSync(resolveManagedProxyCaFileForUrl({
		proxyUrl,
		caFileOverride: process.env["OPENCLAW_PROXY_CA_FILE"]
	}));
	proxylineHandle = installGlobalProxy({
		mode: "managed",
		proxyUrl,
		...proxyTls ? { proxyTls } : {},
		ifActive: "reuse-compatible",
		undici: MANAGED_PROXY_UNDICI_OPTIONS
	});
	forceResetGlobalDispatcher({ preserveProxylineManaged: true });
}
async function startProxy(config) {
	if (config?.enabled !== true) return null;
	const proxyUrl = resolveProxyUrl(config);
	const loopbackMode = config.loopbackMode ?? "gateway-only";
	const proxyCaFile = resolveManagedProxyCaFileForUrl({
		proxyUrl,
		config
	});
	const proxyTls = await loadManagedProxyTlsOptions(proxyCaFile);
	if (getActiveManagedProxyUrl()) {
		const registration = registerActiveManagedProxyUrl(new URL(proxyUrl), {
			loopbackMode,
			proxyTls
		});
		return {
			proxyUrl,
			stop: async () => {
				stopActiveProxyRegistration(registration);
			},
			kill: () => {
				stopActiveProxyRegistration(registration);
			}
		};
	}
	baseProxyEnvSnapshot ??= captureProxyEnv();
	const lifecycleBaseEnvSnapshot = baseProxyEnvSnapshot;
	let registration = null;
	try {
		injectProxyEnv(proxyUrl, loopbackMode, proxyCaFile);
		proxylineHandle = installGlobalProxy({
			mode: "managed",
			proxyUrl,
			...proxyTls ? { proxyTls } : {},
			ifActive: "replace",
			undici: MANAGED_PROXY_UNDICI_OPTIONS
		});
		forceResetGlobalDispatcher({ preserveProxylineManaged: true });
		registration = registerActiveManagedProxyUrl(new URL(proxyUrl), {
			loopbackMode,
			proxyTls
		});
	} catch (err) {
		if (registration) stopActiveManagedProxyRegistration(registration);
		restoreAfterFailedProxyActivation(lifecycleBaseEnvSnapshot);
		throw new Error(`proxy: failed to activate external proxy routing: ${String(err)}`, { cause: err });
	}
	logInfo(`proxy: routing process HTTP traffic through external proxy ${redactProxyUrlForLog(proxyUrl)}`);
	return {
		proxyUrl,
		stop: async () => {
			if (registration) stopActiveProxyRegistration(registration);
		},
		kill: () => {
			if (registration) stopActiveProxyRegistration(registration);
		}
	};
}
async function stopProxy(handle) {
	if (!handle) return;
	await handle.stop();
}
function parseGatewayControlPlaneUrl(value) {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}
function isGatewayControlPlaneProtocol(protocol) {
	return protocol === "ws:" || protocol === "wss:" || protocol === "http:" || protocol === "https:";
}
function getGatewayControlPlaneBypassAuthority(value) {
	const url = parseGatewayControlPlaneUrl(value);
	if (url === null || !isGatewayControlPlaneProtocol(url.protocol) || !isGatewayControlPlaneLoopbackHost(url.hostname)) return null;
	return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}
function registerManagedProxyGatewayLoopbackBypass(url) {
	if (!getGatewayControlPlaneBypassAuthority(url)) return;
	const loopbackMode = getActiveManagedProxyLoopbackMode();
	if (loopbackMode === "block") throw new Error("proxy: Gateway loopback control-plane connections are blocked by proxy.loopbackMode");
	if (loopbackMode === "proxy") return;
	return proxylineHandle?.registerBypass({ url });
}
function isGatewayControlPlaneLoopbackHost(hostname) {
	return hostname.trim().toLowerCase().replace(/\.+$/, "") === "localhost" || isLoopbackIpAddress(hostname);
}
//#endregion
export { stopProxy as i, registerManagedProxyGatewayLoopbackBypass as n, startProxy as r, ensureInheritedManagedProxyRoutingActive as t };
