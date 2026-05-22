import { a as logWarn, r as logInfo } from "./logger-CeZgWgtG.js";
import { u as isLoopbackIpAddress } from "./ip-C_ppe0cm.js";
import { a as forceResetGlobalDispatcher } from "./undici-global-dispatcher-B9CFrUKq.js";
import http from "node:http";
import https from "node:https";
import { bootstrap } from "global-agent";
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
const GLOBAL_AGENT_PROXY_KEYS = ["GLOBAL_AGENT_HTTP_PROXY", "GLOBAL_AGENT_HTTPS_PROXY"];
const GLOBAL_AGENT_FORCE_KEYS = ["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"];
const NO_PROXY_ENV_KEYS = [
	"no_proxy",
	"NO_PROXY",
	"GLOBAL_AGENT_NO_PROXY"
];
const PROXY_ACTIVE_KEYS = ["OPENCLAW_PROXY_ACTIVE"];
const ALL_PROXY_ENV_KEYS = [
	...PROXY_ENV_KEYS,
	...GLOBAL_AGENT_PROXY_KEYS,
	...GLOBAL_AGENT_FORCE_KEYS,
	...NO_PROXY_ENV_KEYS,
	...PROXY_ACTIVE_KEYS
];
const GATEWAY_CONTROL_PLANE_PROXY_BYPASS_ENV_KEYS = [
	...ALL_PROXY_ENV_KEYS,
	"all_proxy",
	"ALL_PROXY"
];
let globalAgentBootstrapped = false;
let nodeHttpStackSnapshot = null;
let activeProxyRegistrations = [];
let baseProxyEnvSnapshot = null;
function _resetGlobalAgentBootstrapForTests() {
	globalAgentBootstrapped = false;
	nodeHttpStackSnapshot = null;
	activeProxyRegistrations = [];
	baseProxyEnvSnapshot = null;
}
function captureProxyEnv() {
	return {
		http_proxy: process.env["http_proxy"],
		https_proxy: process.env["https_proxy"],
		HTTP_PROXY: process.env["HTTP_PROXY"],
		HTTPS_PROXY: process.env["HTTPS_PROXY"],
		GLOBAL_AGENT_HTTP_PROXY: process.env["GLOBAL_AGENT_HTTP_PROXY"],
		GLOBAL_AGENT_HTTPS_PROXY: process.env["GLOBAL_AGENT_HTTPS_PROXY"],
		GLOBAL_AGENT_FORCE_GLOBAL_AGENT: process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"],
		no_proxy: process.env["no_proxy"],
		NO_PROXY: process.env["NO_PROXY"],
		GLOBAL_AGENT_NO_PROXY: process.env["GLOBAL_AGENT_NO_PROXY"],
		OPENCLAW_PROXY_ACTIVE: process.env["OPENCLAW_PROXY_ACTIVE"]
	};
}
function injectProxyEnv(proxyUrl) {
	const snapshot = captureProxyEnv();
	applyProxyEnv(proxyUrl);
	return snapshot;
}
function applyProxyEnv(proxyUrl) {
	for (const key of PROXY_ENV_KEYS) process.env[key] = proxyUrl;
	for (const key of GLOBAL_AGENT_PROXY_KEYS) process.env[key] = proxyUrl;
	process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"] = "true";
	process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
	for (const key of NO_PROXY_ENV_KEYS) process.env[key] = "";
}
function restoreProxyEnv(snapshot) {
	for (const key of ALL_PROXY_ENV_KEYS) {
		const value = snapshot[key];
		if (value === void 0) delete process.env[key];
		else process.env[key] = value;
	}
}
function captureGatewayControlPlaneProxyBypassEnv() {
	const snapshot = {};
	for (const key of GATEWAY_CONTROL_PLANE_PROXY_BYPASS_ENV_KEYS) snapshot[key] = process.env[key];
	return snapshot;
}
function restoreGatewayControlPlaneProxyBypassEnv(snapshot) {
	for (const key of GATEWAY_CONTROL_PLANE_PROXY_BYPASS_ENV_KEYS) {
		const value = snapshot[key];
		if (value === void 0) delete process.env[key];
		else process.env[key] = value;
	}
}
function withoutGatewayControlPlaneProxyEnv(run) {
	const snapshot = captureGatewayControlPlaneProxyBypassEnv();
	for (const key of GATEWAY_CONTROL_PLANE_PROXY_BYPASS_ENV_KEYS) delete process.env[key];
	try {
		return run();
	} finally {
		restoreGatewayControlPlaneProxyBypassEnv(snapshot);
	}
}
function restoreGlobalAgentRuntime(snapshot) {
	if (typeof global === "undefined" || global["GLOBAL_AGENT"] == null) return;
	const agent = global["GLOBAL_AGENT"];
	agent["HTTP_PROXY"] = snapshot["GLOBAL_AGENT_HTTP_PROXY"] ?? "";
	agent["HTTPS_PROXY"] = snapshot["GLOBAL_AGENT_HTTPS_PROXY"] ?? "";
	agent["NO_PROXY"] = snapshot["GLOBAL_AGENT_NO_PROXY"] ?? null;
}
function captureNodeHttpStack() {
	const globalRecord = global;
	return {
		httpRequest: http.request,
		httpGet: http.get,
		httpGlobalAgent: http.globalAgent,
		httpsRequest: https.request,
		httpsGet: https.get,
		httpsGlobalAgent: https.globalAgent,
		hadGlobalAgent: Object.hasOwn(globalRecord, "GLOBAL_AGENT"),
		globalAgent: globalRecord["GLOBAL_AGENT"]
	};
}
function restoreNodeHttpStack() {
	const snapshot = nodeHttpStackSnapshot;
	if (!snapshot) return;
	http.request = snapshot.httpRequest;
	http.get = snapshot.httpGet;
	http.globalAgent = snapshot.httpGlobalAgent;
	https.request = snapshot.httpsRequest;
	https.get = snapshot.httpsGet;
	https.globalAgent = snapshot.httpsGlobalAgent;
	const globalRecord = global;
	if (snapshot.hadGlobalAgent) globalRecord["GLOBAL_AGENT"] = snapshot.globalAgent;
	else delete globalRecord["GLOBAL_AGENT"];
	nodeHttpStackSnapshot = null;
	globalAgentBootstrapped = false;
}
function bootstrapNodeHttpStack(proxyUrl) {
	if (!globalAgentBootstrapped) {
		nodeHttpStackSnapshot = captureNodeHttpStack();
		bootstrap();
		globalAgentBootstrapped = true;
	}
	if (typeof global !== "undefined" && global["GLOBAL_AGENT"] != null) {
		const agent = global["GLOBAL_AGENT"];
		agent["HTTP_PROXY"] = proxyUrl;
		agent["HTTPS_PROXY"] = proxyUrl;
		agent["NO_PROXY"] = process.env["GLOBAL_AGENT_NO_PROXY"];
	}
}
function findTopActiveProxyRegistration() {
	for (let index = activeProxyRegistrations.length - 1; index >= 0; index -= 1) {
		const registration = activeProxyRegistrations[index];
		if (!registration.stopped) return registration;
	}
	return null;
}
function resetUndiciDispatcherForProxyLifecycle() {
	try {
		forceResetGlobalDispatcher();
	} catch (err) {
		logWarn(`proxy: failed to reset undici dispatcher: ${String(err)}`);
	}
}
function restoreGlobalAgentRuntimeForProxyLifecycle(snapshot) {
	try {
		restoreGlobalAgentRuntime(snapshot);
	} catch (err) {
		logWarn(`proxy: failed to reset global-agent: ${String(err)}`);
	}
}
function restoreNodeHttpStackForProxyLifecycle() {
	try {
		restoreNodeHttpStack();
	} catch (err) {
		logWarn(`proxy: failed to restore node HTTP stack: ${String(err)}`);
	}
}
function reapplyActiveProxyRuntime(proxyUrl) {
	applyProxyEnv(proxyUrl);
	resetUndiciDispatcherForProxyLifecycle();
	try {
		bootstrapNodeHttpStack(proxyUrl);
	} catch (err) {
		logWarn(`proxy: failed to refresh node HTTP proxy hooks: ${String(err)}`);
	}
}
function restoreInactiveProxyRuntime(snapshot) {
	restoreProxyEnv(snapshot);
	resetUndiciDispatcherForProxyLifecycle();
	restoreGlobalAgentRuntimeForProxyLifecycle(snapshot);
	restoreNodeHttpStackForProxyLifecycle();
}
function restoreAfterFailedProxyActivation(previousActiveRegistration, restoreSnapshot) {
	if (previousActiveRegistration) {
		reapplyActiveProxyRuntime(previousActiveRegistration.proxyUrl);
		return;
	}
	restoreInactiveProxyRuntime(restoreSnapshot);
	baseProxyEnvSnapshot = null;
}
function stopActiveProxyRegistration(registration) {
	if (registration.stopped) return;
	registration.stopped = true;
	activeProxyRegistrations = activeProxyRegistrations.filter((entry) => !entry.stopped);
	const nextActiveRegistration = findTopActiveProxyRegistration();
	if (nextActiveRegistration) {
		reapplyActiveProxyRuntime(nextActiveRegistration.proxyUrl);
		return;
	}
	const restoreSnapshot = baseProxyEnvSnapshot ?? captureProxyEnv();
	baseProxyEnvSnapshot = null;
	restoreInactiveProxyRuntime(restoreSnapshot);
}
function isSupportedProxyUrl(value) {
	try {
		return new URL(value).protocol === "http:";
	} catch {
		return false;
	}
}
function resolveProxyUrl(config) {
	const candidate = config?.proxyUrl?.trim() || process.env["OPENCLAW_PROXY_URL"]?.trim();
	if (!candidate) throw new Error("proxy: enabled but no HTTP proxy URL is configured; set proxy.proxyUrl or OPENCLAW_PROXY_URL to an http:// forward proxy.");
	if (!isSupportedProxyUrl(candidate)) throw new Error("proxy: enabled but proxy URL is invalid; set proxy.proxyUrl or OPENCLAW_PROXY_URL to an http:// forward proxy.");
	return candidate;
}
function redactProxyUrlForLog(value) {
	try {
		return new URL(value).origin;
	} catch {
		return "<invalid proxy URL>";
	}
}
async function startProxy(config) {
	if (config?.enabled !== true) return null;
	const proxyUrl = resolveProxyUrl(config);
	const previousActiveRegistration = findTopActiveProxyRegistration();
	baseProxyEnvSnapshot ??= captureProxyEnv();
	const lifecycleBaseEnvSnapshot = baseProxyEnvSnapshot;
	let injectedEnvSnapshot = captureProxyEnv();
	let registration = null;
	try {
		injectedEnvSnapshot = injectProxyEnv(proxyUrl);
		forceResetGlobalDispatcher();
		bootstrapNodeHttpStack(proxyUrl);
		registration = {
			proxyUrl,
			stopped: false
		};
		activeProxyRegistrations.push(registration);
	} catch (err) {
		restoreAfterFailedProxyActivation(previousActiveRegistration, lifecycleBaseEnvSnapshot);
		throw new Error(`proxy: failed to activate external proxy routing: ${String(err)}`, { cause: err });
	}
	logInfo(`proxy: routing process HTTP traffic through external proxy ${redactProxyUrlForLog(proxyUrl)}`);
	return {
		proxyUrl,
		injectedProxyUrl: proxyUrl,
		envSnapshot: injectedEnvSnapshot,
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
function isGatewayLoopbackControlPlaneUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:" && url.protocol !== "http:" && url.protocol !== "https:") return false;
	return isGatewayControlPlaneLoopbackHost(url.hostname);
}
function isGatewayControlPlaneLoopbackHost(hostname) {
	return hostname.trim().toLowerCase().replace(/\.+$/, "") === "localhost" || isLoopbackIpAddress(hostname);
}
function dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane(url, run) {
	if (!isGatewayLoopbackControlPlaneUrl(url)) throw new Error("proxy: dangerous Gateway control-plane bypass is loopback-only");
	const snapshot = nodeHttpStackSnapshot;
	if (!snapshot) return withoutGatewayControlPlaneProxyEnv(run);
	return withoutGatewayControlPlaneProxyEnv(() => {
		const activeStack = captureNodeHttpStack();
		const globalRecord = global;
		try {
			http.request = snapshot.httpRequest;
			http.get = snapshot.httpGet;
			http.globalAgent = snapshot.httpGlobalAgent;
			https.request = snapshot.httpsRequest;
			https.get = snapshot.httpsGet;
			https.globalAgent = snapshot.httpsGlobalAgent;
			if (snapshot.hadGlobalAgent) globalRecord["GLOBAL_AGENT"] = snapshot.globalAgent;
			else delete globalRecord["GLOBAL_AGENT"];
			return run();
		} finally {
			http.request = activeStack.httpRequest;
			http.get = activeStack.httpGet;
			http.globalAgent = activeStack.httpGlobalAgent;
			https.request = activeStack.httpsRequest;
			https.get = activeStack.httpsGet;
			https.globalAgent = activeStack.httpsGlobalAgent;
			if (activeStack.hadGlobalAgent) globalRecord["GLOBAL_AGENT"] = activeStack.globalAgent;
			else delete globalRecord["GLOBAL_AGENT"];
		}
	});
}
//#endregion
export { stopProxy as i, dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane as n, startProxy as r, _resetGlobalAgentBootstrapForTests as t };
