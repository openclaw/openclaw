import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import process$1 from "node:process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
//#region src/proxy-capture/paths.ts
function resolveDebugProxyRootDir(env = process.env) {
	return path.join(resolveStateDir(env), "debug-proxy");
}
function resolveDebugProxyDbPath(env = process.env) {
	return path.join(resolveDebugProxyRootDir(env), "capture.sqlite");
}
function resolveDebugProxyBlobDir(env = process.env) {
	return path.join(resolveDebugProxyRootDir(env), "blobs");
}
function resolveDebugProxyCertDir(env = process.env) {
	return path.join(resolveDebugProxyRootDir(env), "certs");
}
//#endregion
//#region src/proxy-capture/env.ts
const OPENCLAW_DEBUG_PROXY_ENABLED = "OPENCLAW_DEBUG_PROXY_ENABLED";
const OPENCLAW_DEBUG_PROXY_URL = "OPENCLAW_DEBUG_PROXY_URL";
const OPENCLAW_DEBUG_PROXY_DB_PATH = "OPENCLAW_DEBUG_PROXY_DB_PATH";
const OPENCLAW_DEBUG_PROXY_BLOB_DIR = "OPENCLAW_DEBUG_PROXY_BLOB_DIR";
const OPENCLAW_DEBUG_PROXY_CERT_DIR = "OPENCLAW_DEBUG_PROXY_CERT_DIR";
const OPENCLAW_DEBUG_PROXY_SESSION_ID = "OPENCLAW_DEBUG_PROXY_SESSION_ID";
const OPENCLAW_DEBUG_PROXY_REQUIRE = "OPENCLAW_DEBUG_PROXY_REQUIRE";
let cachedImplicitSessionId;
function isTruthy(value) {
	return value === "1" || value === "true" || value === "yes" || value === "on";
}
function resolveDebugProxySettings(env = process$1.env) {
	const enabled = isTruthy(env[OPENCLAW_DEBUG_PROXY_ENABLED]);
	const sessionId = (env["OPENCLAW_DEBUG_PROXY_SESSION_ID"]?.trim() || void 0) ?? (cachedImplicitSessionId ??= randomUUID());
	return {
		enabled,
		required: isTruthy(env[OPENCLAW_DEBUG_PROXY_REQUIRE]),
		proxyUrl: env["OPENCLAW_DEBUG_PROXY_URL"]?.trim() || void 0,
		dbPath: env["OPENCLAW_DEBUG_PROXY_DB_PATH"]?.trim() || resolveDebugProxyDbPath(env),
		blobDir: env["OPENCLAW_DEBUG_PROXY_BLOB_DIR"]?.trim() || resolveDebugProxyBlobDir(env),
		certDir: env["OPENCLAW_DEBUG_PROXY_CERT_DIR"]?.trim() || resolveDebugProxyCertDir(env),
		sessionId,
		sourceProcess: "openclaw"
	};
}
function applyDebugProxyEnv(env, params) {
	return {
		...env,
		[OPENCLAW_DEBUG_PROXY_ENABLED]: "1",
		[OPENCLAW_DEBUG_PROXY_REQUIRE]: "1",
		[OPENCLAW_DEBUG_PROXY_URL]: params.proxyUrl,
		[OPENCLAW_DEBUG_PROXY_DB_PATH]: params.dbPath ?? resolveDebugProxyDbPath(env),
		[OPENCLAW_DEBUG_PROXY_BLOB_DIR]: params.blobDir ?? resolveDebugProxyBlobDir(env),
		[OPENCLAW_DEBUG_PROXY_CERT_DIR]: params.certDir ?? resolveDebugProxyCertDir(env),
		[OPENCLAW_DEBUG_PROXY_SESSION_ID]: params.sessionId,
		HTTP_PROXY: params.proxyUrl,
		HTTPS_PROXY: params.proxyUrl,
		ALL_PROXY: params.proxyUrl
	};
}
function createDebugProxyWebSocketAgent(settings) {
	if (!settings.enabled || !settings.proxyUrl) return;
	return new HttpsProxyAgent(settings.proxyUrl);
}
function resolveEffectiveDebugProxyUrl(configuredProxyUrl) {
	const explicit = configuredProxyUrl?.trim();
	if (explicit) return explicit;
	const settings = resolveDebugProxySettings();
	return settings.enabled ? settings.proxyUrl : void 0;
}
//#endregion
export { resolveEffectiveDebugProxyUrl as i, createDebugProxyWebSocketAgent as n, resolveDebugProxySettings as r, applyDebugProxyEnv as t };
