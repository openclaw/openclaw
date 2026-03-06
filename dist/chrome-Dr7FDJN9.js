import { T as resolvePreferredOpenClawTmpDir, t as createSubsystemLogger, u as isDevMode } from "./subsystem-B9UBebHR.js";
import { D as isNotFoundPathError, O as isPathInside } from "./workspace-CJSTaOJf.js";
import { a as CONFIG_DIR } from "./logger-5RiupzZ_.js";
import { Ct as isPrivateOrLoopbackIpAddress, St as isLoopbackIpAddress, W as resolveSecretRefValues, X as loadConfig, _r as normalizeSecretInputString, ft as secretRefKey, vr as resolveSecretInputRef, wt as normalizeIpAddress } from "./model-selection-hBypV7rn.js";
import { a as isErrno } from "./errors-XoYNBNa9.js";
import { i as openFileWithinRoot, t as SafeOpenError } from "./fs-safe-54mRDvhR.js";
import { o as isPrivateNetworkAllowedByPolicy, s as resolvePinnedHostnameWithPolicy, t as hasProxyEnvConfigured } from "./proxy-env-8K0ubHqJ.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fs$1 from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import net from "node:net";
import http, { createServer } from "node:http";
import https from "node:https";
import WebSocket, { WebSocketServer } from "ws";
import { Buffer as Buffer$1 } from "node:buffer";

//#region src/browser/constants.ts
const DEFAULT_OPENCLAW_BROWSER_ENABLED = true;
const DEFAULT_BROWSER_EVALUATE_ENABLED = true;
const DEFAULT_OPENCLAW_BROWSER_COLOR = "#FF4500";
const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = "openclaw";
const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "openclaw";
const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 8e4;
const DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS = 1e4;
const DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH = 6;

//#endregion
//#region src/gateway/net.ts
function isLoopbackAddress(ip) {
	return isLoopbackIpAddress(ip);
}
/**
* Returns true if the IP belongs to a private or loopback network range.
* Private ranges: RFC1918, link-local, ULA IPv6, and CGNAT (100.64/10), plus loopback.
*/
function isPrivateOrLoopbackAddress(ip) {
	return isPrivateOrLoopbackIpAddress(ip);
}
function normalizeIp(ip) {
	return normalizeIpAddress(ip);
}
/**
* Check if a hostname or IP refers to the local machine.
* Handles: localhost, 127.x.x.x, ::1, [::1], ::ffff:127.x.x.x
* Note: 0.0.0.0 and :: are NOT loopback - they bind to all interfaces.
*/
function isLoopbackHost(host) {
	const parsed = parseHostForAddressChecks(host);
	if (!parsed) return false;
	if (parsed.isLocalhost) return true;
	return isLoopbackAddress(parsed.unbracketedHost);
}
/**
* Check if a hostname or IP refers to a private or loopback address.
* Handles the same hostname formats as isLoopbackHost, but also accepts
* RFC 1918, link-local, CGNAT, and IPv6 ULA/link-local addresses.
*/
function isPrivateOrLoopbackHost(host) {
	const parsed = parseHostForAddressChecks(host);
	if (!parsed) return false;
	if (parsed.isLocalhost) return true;
	const normalized = normalizeIp(parsed.unbracketedHost);
	if (!normalized || !isPrivateOrLoopbackAddress(normalized)) return false;
	if (net.isIP(normalized) === 6) {
		if (normalized.startsWith("ff")) return false;
		if (normalized === "::") return false;
	}
	return true;
}
function parseHostForAddressChecks(host) {
	if (!host) return null;
	const normalizedHost = host.trim().toLowerCase();
	if (normalizedHost === "localhost") return {
		isLocalhost: true,
		unbracketedHost: normalizedHost
	};
	return {
		isLocalhost: false,
		unbracketedHost: normalizedHost.startsWith("[") && normalizedHost.endsWith("]") ? normalizedHost.slice(1, -1) : normalizedHost
	};
}
/**
* Security check for WebSocket URLs (CWE-319: Cleartext Transmission of Sensitive Information).
*
* Returns true if the URL is secure for transmitting data:
* - wss:// (TLS) is always secure
* - ws:// is secure only for loopback addresses by default
* - optional break-glass: private ws:// can be enabled for trusted networks
*
* All other ws:// URLs are considered insecure because both credentials
* AND chat/conversation data would be exposed to network interception.
*/
function isSecureWebSocketUrl(url, opts) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol === "wss:") return true;
	if (parsed.protocol !== "ws:") return false;
	if (isLoopbackHost(parsed.hostname)) return true;
	if (opts?.allowPrivateWs) return isPrivateOrLoopbackHost(parsed.hostname);
	return false;
}

//#endregion
//#region src/browser/form-fields.ts
const DEFAULT_FILL_FIELD_TYPE = "text";
function normalizeBrowserFormFieldRef(value) {
	return typeof value === "string" ? value.trim() : "";
}
function normalizeBrowserFormFieldType(value) {
	return (typeof value === "string" ? value.trim() : "") || DEFAULT_FILL_FIELD_TYPE;
}
function normalizeBrowserFormFieldValue(value) {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : void 0;
}
function normalizeBrowserFormField(record) {
	const ref = normalizeBrowserFormFieldRef(record.ref);
	if (!ref) return null;
	const type = normalizeBrowserFormFieldType(record.type);
	const value = normalizeBrowserFormFieldValue(record.value);
	return value === void 0 ? {
		ref,
		type
	} : {
		ref,
		type,
		value
	};
}

//#endregion
//#region src/browser/paths.ts
const DEFAULT_BROWSER_TMP_DIR = resolvePreferredOpenClawTmpDir();
const DEFAULT_TRACE_DIR = DEFAULT_BROWSER_TMP_DIR;
const DEFAULT_DOWNLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "downloads");
const DEFAULT_UPLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "uploads");
function invalidPath(scopeLabel) {
	return {
		ok: false,
		error: `Invalid path: must stay within ${scopeLabel}`
	};
}
async function resolveRealPathIfExists(targetPath) {
	try {
		return await fs.realpath(targetPath);
	} catch {
		return;
	}
}
async function resolveTrustedRootRealPath(rootDir) {
	try {
		const rootLstat = await fs.lstat(rootDir);
		if (!rootLstat.isDirectory() || rootLstat.isSymbolicLink()) return;
		return await fs.realpath(rootDir);
	} catch {
		return;
	}
}
async function validateCanonicalPathWithinRoot(params) {
	try {
		const candidateLstat = await fs.lstat(params.candidatePath);
		if (candidateLstat.isSymbolicLink()) return "invalid";
		if (params.expect === "directory" && !candidateLstat.isDirectory()) return "invalid";
		if (params.expect === "file" && !candidateLstat.isFile()) return "invalid";
		if (params.expect === "file" && candidateLstat.nlink > 1) return "invalid";
		const candidateRealPath = await fs.realpath(params.candidatePath);
		return isPathInside(params.rootRealPath, candidateRealPath) ? "ok" : "invalid";
	} catch (err) {
		return isNotFoundPathError(err) ? "not-found" : "invalid";
	}
}
function resolvePathWithinRoot(params) {
	const root = path.resolve(params.rootDir);
	const raw = params.requestedPath.trim();
	if (!raw) {
		if (!params.defaultFileName) return {
			ok: false,
			error: "path is required"
		};
		return {
			ok: true,
			path: path.join(root, params.defaultFileName)
		};
	}
	const resolved = path.resolve(root, raw);
	const rel = path.relative(root, resolved);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return {
		ok: false,
		error: `Invalid path: must stay within ${params.scopeLabel}`
	};
	return {
		ok: true,
		path: resolved
	};
}
async function resolveWritablePathWithinRoot(params) {
	const lexical = resolvePathWithinRoot(params);
	if (!lexical.ok) return lexical;
	const rootRealPath = await resolveTrustedRootRealPath(path.resolve(params.rootDir));
	if (!rootRealPath) return invalidPath(params.scopeLabel);
	const requestedPath = lexical.path;
	if (await validateCanonicalPathWithinRoot({
		rootRealPath,
		candidatePath: path.dirname(requestedPath),
		expect: "directory"
	}) !== "ok") return invalidPath(params.scopeLabel);
	if (await validateCanonicalPathWithinRoot({
		rootRealPath,
		candidatePath: requestedPath,
		expect: "file"
	}) === "invalid") return invalidPath(params.scopeLabel);
	return lexical;
}
async function resolveExistingPathsWithinRoot(params) {
	return await resolveCheckedPathsWithinRoot({
		...params,
		allowMissingFallback: true
	});
}
async function resolveStrictExistingPathsWithinRoot(params) {
	return await resolveCheckedPathsWithinRoot({
		...params,
		allowMissingFallback: false
	});
}
async function resolveCheckedPathsWithinRoot(params) {
	const rootDir = path.resolve(params.rootDir);
	const rootRealPath = await resolveRealPathIfExists(rootDir);
	const isInRoot = (relativePath) => Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
	const resolveExistingRelativePath = async (requestedPath) => {
		const raw = requestedPath.trim();
		const lexicalPathResult = resolvePathWithinRoot({
			rootDir,
			requestedPath,
			scopeLabel: params.scopeLabel
		});
		if (lexicalPathResult.ok) return {
			ok: true,
			relativePath: path.relative(rootDir, lexicalPathResult.path),
			fallbackPath: lexicalPathResult.path
		};
		if (!rootRealPath || !raw || !path.isAbsolute(raw)) return lexicalPathResult;
		try {
			const resolvedExistingPath = await fs.realpath(raw);
			const relativePath = path.relative(rootRealPath, resolvedExistingPath);
			if (!isInRoot(relativePath)) return lexicalPathResult;
			return {
				ok: true,
				relativePath,
				fallbackPath: resolvedExistingPath
			};
		} catch {
			return lexicalPathResult;
		}
	};
	const resolvedPaths = [];
	for (const raw of params.requestedPaths) {
		const pathResult = await resolveExistingRelativePath(raw);
		if (!pathResult.ok) return {
			ok: false,
			error: pathResult.error
		};
		let opened;
		try {
			opened = await openFileWithinRoot({
				rootDir,
				relativePath: pathResult.relativePath
			});
			resolvedPaths.push(opened.realPath);
		} catch (err) {
			if (params.allowMissingFallback && err instanceof SafeOpenError && err.code === "not-found") {
				resolvedPaths.push(pathResult.fallbackPath);
				continue;
			}
			if (err instanceof SafeOpenError && err.code === "outside-workspace") return {
				ok: false,
				error: `File is outside ${params.scopeLabel}`
			};
			return {
				ok: false,
				error: `Invalid path: must stay within ${params.scopeLabel} and be a regular non-symlink file`
			};
		} finally {
			await opened?.handle.close().catch(() => {});
		}
	}
	return {
		ok: true,
		paths: resolvedPaths
	};
}

//#endregion
//#region src/infra/ws.ts
function rawDataToString(data, encoding = "utf8") {
	if (typeof data === "string") return data;
	if (Buffer$1.isBuffer(data)) return data.toString(encoding);
	if (Array.isArray(data)) return Buffer$1.concat(data).toString(encoding);
	if (data instanceof ArrayBuffer) return Buffer$1.from(data).toString(encoding);
	return Buffer$1.from(String(data)).toString(encoding);
}

//#endregion
//#region src/browser/cdp-proxy-bypass.ts
/**
* Proxy bypass for CDP (Chrome DevTools Protocol) localhost connections.
*
* When HTTP_PROXY / HTTPS_PROXY / ALL_PROXY environment variables are set,
* CDP connections to localhost/127.0.0.1 can be incorrectly routed through
* the proxy, causing browser control to fail.
*
* @see https://github.com/nicepkg/openclaw/issues/31219
*/
/** HTTP agent that never uses a proxy — for localhost CDP connections. */
const directHttpAgent = new http.Agent();
const directHttpsAgent = new https.Agent();
/**
* Returns a plain (non-proxy) agent for WebSocket or HTTP connections
* when the target is a loopback address. Returns `undefined` otherwise
* so callers fall through to their default behaviour.
*/
function getDirectAgentForCdp(url) {
	try {
		const parsed = new URL(url);
		if (isLoopbackHost(parsed.hostname)) return parsed.protocol === "https:" || parsed.protocol === "wss:" ? directHttpsAgent : directHttpAgent;
	} catch {}
}
/**
* Returns `true` when any proxy-related env var is set that could
* interfere with loopback connections.
*/
function hasProxyEnv() {
	return hasProxyEnvConfigured();
}
const LOOPBACK_ENTRIES = "localhost,127.0.0.1,[::1]";
function noProxyAlreadyCoversLocalhost() {
	const current = process.env.NO_PROXY || process.env.no_proxy || "";
	return current.includes("localhost") && current.includes("127.0.0.1") && current.includes("[::1]");
}
function isLoopbackCdpUrl(url) {
	try {
		return isLoopbackHost(new URL(url).hostname);
	} catch {
		return false;
	}
}
var NoProxyLeaseManager = class {
	constructor() {
		this.leaseCount = 0;
		this.snapshot = null;
	}
	acquire(url) {
		if (!isLoopbackCdpUrl(url) || !hasProxyEnv()) return null;
		if (this.leaseCount === 0 && !noProxyAlreadyCoversLocalhost()) {
			const noProxy = process.env.NO_PROXY;
			const noProxyLower = process.env.no_proxy;
			const current = noProxy || noProxyLower || "";
			const applied = current ? `${current},${LOOPBACK_ENTRIES}` : LOOPBACK_ENTRIES;
			process.env.NO_PROXY = applied;
			process.env.no_proxy = applied;
			this.snapshot = {
				noProxy,
				noProxyLower,
				applied
			};
		}
		this.leaseCount += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.release();
		};
	}
	release() {
		if (this.leaseCount <= 0) return;
		this.leaseCount -= 1;
		if (this.leaseCount > 0 || !this.snapshot) return;
		const { noProxy, noProxyLower, applied } = this.snapshot;
		const currentNoProxy = process.env.NO_PROXY;
		const currentNoProxyLower = process.env.no_proxy;
		if (currentNoProxy === applied && (currentNoProxyLower === applied || currentNoProxyLower === void 0)) {
			if (noProxy !== void 0) process.env.NO_PROXY = noProxy;
			else delete process.env.NO_PROXY;
			if (noProxyLower !== void 0) process.env.no_proxy = noProxyLower;
			else delete process.env.no_proxy;
		}
		this.snapshot = null;
	}
};
const noProxyLeaseManager = new NoProxyLeaseManager();
/**
* Scoped NO_PROXY bypass for loopback CDP URLs.
*
* This wrapper only mutates env vars for loopback destinations. On restore,
* it avoids clobbering external NO_PROXY changes that happened while calls
* were in-flight.
*/
async function withNoProxyForCdpUrl(url, fn) {
	const release = noProxyLeaseManager.acquire(url);
	try {
		return await fn();
	} finally {
		release?.();
	}
}

//#endregion
//#region src/browser/cdp-timeouts.ts
const CDP_HTTP_REQUEST_TIMEOUT_MS = 1500;
const CDP_WS_HANDSHAKE_TIMEOUT_MS = 5e3;
const CDP_JSON_NEW_TIMEOUT_MS = 1500;
const CHROME_REACHABILITY_TIMEOUT_MS = 500;
const CHROME_WS_READY_TIMEOUT_MS = 800;
const CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS = 1e4;
const CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS = 5e3;
const CHROME_LAUNCH_READY_WINDOW_MS = 15e3;
const CHROME_LAUNCH_READY_POLL_MS = 200;
const CHROME_STOP_TIMEOUT_MS = 2500;
const CHROME_STOP_PROBE_TIMEOUT_MS = 200;
const CHROME_STDERR_HINT_MAX_CHARS = 2e3;
const PROFILE_HTTP_REACHABILITY_TIMEOUT_MS = 300;
const PROFILE_WS_REACHABILITY_MIN_TIMEOUT_MS = 200;
const PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS = 2e3;
const PROFILE_ATTACH_RETRY_TIMEOUT_MS = 1200;
const PROFILE_POST_RESTART_WS_TIMEOUT_MS = 600;
function normalizeTimeoutMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return Math.max(1, Math.floor(value));
}
function resolveCdpReachabilityTimeouts(params) {
	const normalized = normalizeTimeoutMs(params.timeoutMs);
	if (params.profileIsLoopback) {
		const httpTimeoutMs = normalized ?? PROFILE_HTTP_REACHABILITY_TIMEOUT_MS;
		return {
			httpTimeoutMs,
			wsTimeoutMs: Math.max(PROFILE_WS_REACHABILITY_MIN_TIMEOUT_MS, Math.min(PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS, httpTimeoutMs * 2))
		};
	}
	if (normalized !== void 0) return {
		httpTimeoutMs: Math.max(normalized, params.remoteHttpTimeoutMs),
		wsTimeoutMs: Math.max(normalized * 2, params.remoteHandshakeTimeoutMs)
	};
	return {
		httpTimeoutMs: params.remoteHttpTimeoutMs,
		wsTimeoutMs: params.remoteHandshakeTimeoutMs
	};
}

//#endregion
//#region src/browser/extension-relay-auth.ts
const RELAY_TOKEN_CONTEXT = "openclaw-extension-relay-v1";
const DEFAULT_RELAY_PROBE_TIMEOUT_MS = 500;
const OPENCLAW_RELAY_BROWSER = "OpenClaw/extension-relay";
var SecretRefUnavailableError = class extends Error {
	constructor(..._args) {
		super(..._args);
		this.isSecretRefUnavailable = true;
	}
};
function trimToUndefined(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
async function resolveGatewayAuthToken() {
	const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
	if (envToken) return envToken;
	try {
		const cfg = loadConfig();
		const tokenRef = resolveSecretInputRef({
			value: cfg.gateway?.auth?.token,
			defaults: cfg.secrets?.defaults
		}).ref;
		if (tokenRef) {
			const refLabel = `${tokenRef.source}:${tokenRef.provider}:${tokenRef.id}`;
			try {
				const resolvedToken = trimToUndefined((await resolveSecretRefValues([tokenRef], {
					config: cfg,
					env: process.env
				})).get(secretRefKey(tokenRef)));
				if (resolvedToken) return resolvedToken;
			} catch {}
			throw new SecretRefUnavailableError(`extension relay requires a resolved gateway token, but gateway.auth.token SecretRef is unavailable (${refLabel}). Set OPENCLAW_GATEWAY_TOKEN or resolve your secret provider.`);
		}
		const configToken = normalizeSecretInputString(cfg.gateway?.auth?.token);
		if (configToken) return configToken;
	} catch (err) {
		if (err instanceof SecretRefUnavailableError) throw err;
	}
	return null;
}
function deriveRelayAuthToken(gatewayToken, port) {
	return createHmac("sha256", gatewayToken).update(`${RELAY_TOKEN_CONTEXT}:${port}`).digest("hex");
}
async function resolveRelayAcceptedTokensForPort(port) {
	const gatewayToken = await resolveGatewayAuthToken();
	if (!gatewayToken) throw new Error("extension relay requires gateway auth token (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)");
	const relayToken = deriveRelayAuthToken(gatewayToken, port);
	if (relayToken === gatewayToken) return [relayToken];
	return [relayToken, gatewayToken];
}
async function resolveRelayAuthTokenForPort(port) {
	return (await resolveRelayAcceptedTokensForPort(port))[0];
}
async function probeAuthenticatedOpenClawRelay(params) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), params.timeoutMs ?? DEFAULT_RELAY_PROBE_TIMEOUT_MS);
	try {
		const versionUrl = new URL("/json/version", `${params.baseUrl}/`).toString();
		const res = await fetch(versionUrl, {
			signal: ctrl.signal,
			headers: { [params.relayAuthHeader]: params.relayAuthToken }
		});
		if (!res.ok) return false;
		const body = await res.json();
		return (typeof body?.Browser === "string" ? body.Browser.trim() : "") === OPENCLAW_RELAY_BROWSER;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

//#endregion
//#region src/browser/extension-relay.ts
const RELAY_AUTH_HEADER = "x-openclaw-relay-token";
const DEFAULT_EXTENSION_RECONNECT_GRACE_MS = 2e4;
const DEFAULT_EXTENSION_COMMAND_RECONNECT_WAIT_MS = 3e3;
function headerValue(value) {
	if (!value) return;
	if (Array.isArray(value)) return value[0];
	return value;
}
function getHeader(req, name) {
	return headerValue(req.headers[name.toLowerCase()]);
}
function getRelayAuthTokenFromRequest(req, url) {
	const headerToken = getHeader(req, RELAY_AUTH_HEADER)?.trim();
	if (headerToken) return headerToken;
	const queryToken = url?.searchParams.get("token")?.trim();
	if (queryToken) return queryToken;
}
function parseUrlPort(parsed) {
	const port = parsed.port?.trim() !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
	if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
	return port;
}
function parseBaseUrl(raw) {
	const parsed = new URL(raw.trim().replace(/\/$/, ""));
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`extension relay cdpUrl must be http(s), got ${parsed.protocol}`);
	const host = parsed.hostname;
	const port = parseUrlPort(parsed);
	if (!port) throw new Error(`extension relay cdpUrl has invalid port: ${parsed.port || "(empty)"}`);
	return {
		host,
		port,
		baseUrl: parsed.toString().replace(/\/$/, "")
	};
}
function text(res, status, bodyText) {
	const body = Buffer.from(bodyText);
	res.write(`HTTP/1.1 ${status} ${status === 200 ? "OK" : "ERR"}\r\nContent-Type: text/plain; charset=utf-8\r
Content-Length: ${body.length}\r\nConnection: close\r
\r
`);
	res.write(body);
	res.end();
}
function rejectUpgrade(socket, status, bodyText) {
	text(socket, status, bodyText);
	try {
		socket.destroy();
	} catch {}
}
function envMsOrDefault(name, fallback) {
	const raw = process.env[name];
	if (!raw || raw.trim() === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}
const relayRuntimeByPort = /* @__PURE__ */ new Map();
const relayInitByPort = /* @__PURE__ */ new Map();
function isAddrInUseError(err) {
	return typeof err === "object" && err !== null && "code" in err && err.code === "EADDRINUSE";
}
function relayAuthTokenForUrl(url) {
	try {
		const parsed = new URL(url);
		if (!isLoopbackHost(parsed.hostname)) return null;
		const port = parseUrlPort(parsed);
		if (!port) return null;
		return relayRuntimeByPort.get(port)?.relayAuthToken ?? null;
	} catch {
		return null;
	}
}
function getChromeExtensionRelayAuthHeaders(url) {
	const token = relayAuthTokenForUrl(url);
	if (!token) return {};
	return { [RELAY_AUTH_HEADER]: token };
}
async function ensureChromeExtensionRelayServer(opts) {
	const info = parseBaseUrl(opts.cdpUrl);
	if (!isLoopbackHost(info.host)) throw new Error(`extension relay requires loopback cdpUrl host (got ${info.host})`);
	const existing = relayRuntimeByPort.get(info.port);
	if (existing) return existing.server;
	const inFlight = relayInitByPort.get(info.port);
	if (inFlight) return await inFlight;
	const extensionReconnectGraceMs = envMsOrDefault("OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS", DEFAULT_EXTENSION_RECONNECT_GRACE_MS);
	const extensionCommandReconnectWaitMs = envMsOrDefault("OPENCLAW_EXTENSION_RELAY_COMMAND_RECONNECT_WAIT_MS", DEFAULT_EXTENSION_COMMAND_RECONNECT_WAIT_MS);
	const initPromise = (async () => {
		const relayAuthToken = await resolveRelayAuthTokenForPort(info.port);
		const relayAuthTokens = new Set(await resolveRelayAcceptedTokensForPort(info.port));
		let extensionWs = null;
		const cdpClients = /* @__PURE__ */ new Set();
		const connectedTargets = /* @__PURE__ */ new Map();
		const extensionConnected = () => extensionWs?.readyState === WebSocket.OPEN;
		const hasConnectedTargets = () => connectedTargets.size > 0;
		let extensionDisconnectCleanupTimer = null;
		const extensionReconnectWaiters = /* @__PURE__ */ new Set();
		const flushExtensionReconnectWaiters = (connected) => {
			if (extensionReconnectWaiters.size === 0) return;
			const waiters = Array.from(extensionReconnectWaiters);
			extensionReconnectWaiters.clear();
			for (const waiter of waiters) waiter(connected);
		};
		const clearExtensionDisconnectCleanupTimer = () => {
			if (!extensionDisconnectCleanupTimer) return;
			clearTimeout(extensionDisconnectCleanupTimer);
			extensionDisconnectCleanupTimer = null;
		};
		const closeCdpClientsAfterExtensionDisconnect = () => {
			connectedTargets.clear();
			for (const client of cdpClients) try {
				client.close(1011, "extension disconnected");
			} catch {}
			cdpClients.clear();
			flushExtensionReconnectWaiters(false);
		};
		const scheduleExtensionDisconnectCleanup = () => {
			clearExtensionDisconnectCleanupTimer();
			extensionDisconnectCleanupTimer = setTimeout(() => {
				extensionDisconnectCleanupTimer = null;
				if (extensionConnected()) return;
				closeCdpClientsAfterExtensionDisconnect();
			}, extensionReconnectGraceMs);
		};
		const waitForExtensionReconnect = async (timeoutMs) => {
			if (extensionConnected()) return true;
			return await new Promise((resolve) => {
				let settled = false;
				const waiter = (connected) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					extensionReconnectWaiters.delete(waiter);
					resolve(connected);
				};
				const timer = setTimeout(() => {
					waiter(false);
				}, timeoutMs);
				extensionReconnectWaiters.add(waiter);
			});
		};
		const pendingExtension = /* @__PURE__ */ new Map();
		let nextExtensionId = 1;
		const sendToExtension = async (payload) => {
			const ws = extensionWs;
			if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("Chrome extension not connected");
			ws.send(JSON.stringify(payload));
			return await new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pendingExtension.delete(payload.id);
					reject(/* @__PURE__ */ new Error(`extension request timeout: ${payload.params.method}`));
				}, 3e4);
				pendingExtension.set(payload.id, {
					resolve,
					reject,
					timer
				});
			});
		};
		const broadcastToCdpClients = (evt) => {
			const msg = JSON.stringify(evt);
			for (const ws of cdpClients) {
				if (ws.readyState !== WebSocket.OPEN) continue;
				ws.send(msg);
			}
		};
		const sendResponseToCdp = (ws, res) => {
			if (ws.readyState !== WebSocket.OPEN) return;
			ws.send(JSON.stringify(res));
		};
		const dropConnectedTargetSession = (sessionId) => {
			const existing = connectedTargets.get(sessionId);
			if (!existing) return;
			connectedTargets.delete(sessionId);
			return existing;
		};
		const dropConnectedTargetsByTargetId = (targetId) => {
			const removed = [];
			for (const [sessionId, target] of connectedTargets) {
				if (target.targetId !== targetId) continue;
				connectedTargets.delete(sessionId);
				removed.push(target);
			}
			return removed;
		};
		const broadcastDetachedTarget = (target, targetId) => {
			broadcastToCdpClients({
				method: "Target.detachedFromTarget",
				params: {
					sessionId: target.sessionId,
					targetId: targetId ?? target.targetId
				},
				sessionId: target.sessionId
			});
		};
		const isMissingTargetError = (err) => {
			const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
			return message.includes("target not found") || message.includes("no target with given id") || message.includes("session not found") || message.includes("cannot find session");
		};
		const pruneStaleTargetsFromCommandFailure = (cmd, err) => {
			if (!isMissingTargetError(err)) return;
			if (cmd.sessionId) {
				const removed = dropConnectedTargetSession(cmd.sessionId);
				if (removed) {
					broadcastDetachedTarget(removed);
					return;
				}
			}
			const params = cmd.params ?? {};
			const targetId = typeof params.targetId === "string" ? params.targetId : void 0;
			if (!targetId) return;
			const removedTargets = dropConnectedTargetsByTargetId(targetId);
			for (const removed of removedTargets) broadcastDetachedTarget(removed, targetId);
		};
		const ensureTargetEventsForClient = (ws, mode) => {
			for (const target of connectedTargets.values()) if (mode === "autoAttach") ws.send(JSON.stringify({
				method: "Target.attachedToTarget",
				params: {
					sessionId: target.sessionId,
					targetInfo: {
						...target.targetInfo,
						attached: true
					},
					waitingForDebugger: false
				}
			}));
			else ws.send(JSON.stringify({
				method: "Target.targetCreated",
				params: { targetInfo: {
					...target.targetInfo,
					attached: true
				} }
			}));
		};
		const routeCdpCommand = async (cmd) => {
			switch (cmd.method) {
				case "Browser.getVersion": return {
					protocolVersion: "1.3",
					product: "Chrome/OpenClaw-Extension-Relay",
					revision: "0",
					userAgent: "OpenClaw-Extension-Relay",
					jsVersion: "V8"
				};
				case "Browser.setDownloadBehavior": return {};
				case "Target.setAutoAttach":
				case "Target.setDiscoverTargets": return {};
				case "Target.getTargets": return { targetInfos: Array.from(connectedTargets.values()).map((t) => ({
					...t.targetInfo,
					attached: true
				})) };
				case "Target.getTargetInfo": {
					const params = cmd.params ?? {};
					const targetId = typeof params.targetId === "string" ? params.targetId : void 0;
					if (targetId) {
						for (const t of connectedTargets.values()) if (t.targetId === targetId) return { targetInfo: t.targetInfo };
					}
					if (cmd.sessionId && connectedTargets.has(cmd.sessionId)) {
						const t = connectedTargets.get(cmd.sessionId);
						if (t) return { targetInfo: t.targetInfo };
					}
					return { targetInfo: Array.from(connectedTargets.values())[0]?.targetInfo };
				}
				case "Target.attachToTarget": {
					const params = cmd.params ?? {};
					const targetId = typeof params.targetId === "string" ? params.targetId : void 0;
					if (!targetId) throw new Error("targetId required");
					for (const t of connectedTargets.values()) if (t.targetId === targetId) return { sessionId: t.sessionId };
					throw new Error("target not found");
				}
				default: return await sendToExtension({
					id: nextExtensionId++,
					method: "forwardCDPCommand",
					params: {
						method: cmd.method,
						sessionId: cmd.sessionId,
						params: cmd.params
					}
				});
			}
		};
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", info.baseUrl);
			const path = url.pathname;
			const origin = getHeader(req, "origin");
			const isChromeExtensionOrigin = typeof origin === "string" && origin.startsWith("chrome-extension://");
			if (isChromeExtensionOrigin && origin) {
				res.setHeader("Access-Control-Allow-Origin", origin);
				res.setHeader("Vary", "Origin");
			}
			if (req.method === "OPTIONS") {
				if (origin && !isChromeExtensionOrigin) {
					res.writeHead(403);
					res.end("Forbidden");
					return;
				}
				const requestedHeaders = (getHeader(req, "access-control-request-headers") ?? "").split(",").map((header) => header.trim().toLowerCase()).filter((header) => header.length > 0);
				const allowedHeaders = new Set([
					"content-type",
					RELAY_AUTH_HEADER,
					...requestedHeaders
				]);
				res.writeHead(204, {
					"Access-Control-Allow-Origin": origin ?? "*",
					"Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
					"Access-Control-Allow-Headers": Array.from(allowedHeaders).join(", "),
					"Access-Control-Max-Age": "86400",
					Vary: "Origin, Access-Control-Request-Headers"
				});
				res.end();
				return;
			}
			if (path.startsWith("/json")) {
				const token = getRelayAuthTokenFromRequest(req, url);
				if (!token || !relayAuthTokens.has(token)) {
					res.writeHead(401);
					res.end("Unauthorized");
					return;
				}
			}
			if (req.method === "HEAD" && path === "/") {
				res.writeHead(200);
				res.end();
				return;
			}
			if (path === "/") {
				res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("OK");
				return;
			}
			if (path === "/extension/status") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ connected: extensionConnected() }));
				return;
			}
			const cdpWsUrl = `${`ws://${req.headers.host?.trim() || `${info.host}:${info.port}`}`}/cdp`;
			if ((path === "/json/version" || path === "/json/version/") && (req.method === "GET" || req.method === "PUT")) {
				const payload = {
					Browser: "OpenClaw/extension-relay",
					"Protocol-Version": "1.3"
				};
				if (extensionConnected() || hasConnectedTargets()) payload.webSocketDebuggerUrl = cdpWsUrl;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(payload));
				return;
			}
			if (new Set([
				"/json",
				"/json/",
				"/json/list",
				"/json/list/"
			]).has(path) && (req.method === "GET" || req.method === "PUT")) {
				const list = Array.from(connectedTargets.values()).map((t) => ({
					id: t.targetId,
					type: t.targetInfo.type ?? "page",
					title: t.targetInfo.title ?? "",
					description: t.targetInfo.title ?? "",
					url: t.targetInfo.url ?? "",
					webSocketDebuggerUrl: cdpWsUrl,
					devtoolsFrontendUrl: `/devtools/inspector.html?ws=${cdpWsUrl.replace("ws://", "")}`
				}));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(list));
				return;
			}
			const handleTargetActionRoute = (match, cdpMethod) => {
				if (!match || req.method !== "GET" && req.method !== "PUT") return false;
				let targetId = "";
				try {
					targetId = decodeURIComponent(match[1] ?? "").trim();
				} catch {
					res.writeHead(400);
					res.end("invalid targetId encoding");
					return true;
				}
				if (!targetId) {
					res.writeHead(400);
					res.end("targetId required");
					return true;
				}
				(async () => {
					try {
						await sendToExtension({
							id: nextExtensionId++,
							method: "forwardCDPCommand",
							params: {
								method: cdpMethod,
								params: { targetId }
							}
						});
					} catch {}
				})();
				res.writeHead(200);
				res.end("OK");
				return true;
			};
			if (handleTargetActionRoute(path.match(/^\/json\/activate\/(.+)$/), "Target.activateTarget")) return;
			if (handleTargetActionRoute(path.match(/^\/json\/close\/(.+)$/), "Target.closeTarget")) return;
			res.writeHead(404);
			res.end("not found");
		});
		const wssExtension = new WebSocketServer({ noServer: true });
		const wssCdp = new WebSocketServer({ noServer: true });
		server.on("upgrade", (req, socket, head) => {
			const url = new URL(req.url ?? "/", info.baseUrl);
			const pathname = url.pathname;
			const remote = req.socket.remoteAddress;
			if (!isLoopbackAddress(remote)) {
				rejectUpgrade(socket, 403, "Forbidden");
				return;
			}
			const origin = headerValue(req.headers.origin);
			if (origin && !origin.startsWith("chrome-extension://")) {
				rejectUpgrade(socket, 403, "Forbidden: invalid origin");
				return;
			}
			if (pathname === "/extension") {
				const token = getRelayAuthTokenFromRequest(req, url);
				if (!token || !relayAuthTokens.has(token)) {
					rejectUpgrade(socket, 401, "Unauthorized");
					return;
				}
				if (extensionWs && extensionWs.readyState !== WebSocket.OPEN) {
					try {
						extensionWs.terminate();
					} catch {}
					extensionWs = null;
				}
				if (extensionConnected()) {
					rejectUpgrade(socket, 409, "Extension already connected");
					return;
				}
				wssExtension.handleUpgrade(req, socket, head, (ws) => {
					wssExtension.emit("connection", ws, req);
				});
				return;
			}
			if (pathname === "/cdp") {
				const token = getRelayAuthTokenFromRequest(req, url);
				if (!token || !relayAuthTokens.has(token)) {
					rejectUpgrade(socket, 401, "Unauthorized");
					return;
				}
				wssCdp.handleUpgrade(req, socket, head, (ws) => {
					wssCdp.emit("connection", ws, req);
				});
				return;
			}
			rejectUpgrade(socket, 404, "Not Found");
		});
		wssExtension.on("connection", (ws) => {
			extensionWs = ws;
			clearExtensionDisconnectCleanupTimer();
			flushExtensionReconnectWaiters(true);
			const ping = setInterval(() => {
				if (ws.readyState !== WebSocket.OPEN) return;
				ws.send(JSON.stringify({ method: "ping" }));
			}, 5e3);
			ws.on("message", (data) => {
				if (extensionWs !== ws) return;
				let parsed = null;
				try {
					parsed = JSON.parse(rawDataToString(data));
				} catch {
					return;
				}
				if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "number") {
					const pending = pendingExtension.get(parsed.id);
					if (!pending) return;
					pendingExtension.delete(parsed.id);
					clearTimeout(pending.timer);
					if ("error" in parsed && typeof parsed.error === "string" && parsed.error.trim()) pending.reject(new Error(parsed.error));
					else pending.resolve(parsed.result);
					return;
				}
				if (parsed && typeof parsed === "object" && "method" in parsed) {
					if (parsed.method === "pong") return;
					if (parsed.method !== "forwardCDPEvent") return;
					const evt = parsed;
					const method = evt.params?.method;
					const params = evt.params?.params;
					const sessionId = evt.params?.sessionId;
					if (!method || typeof method !== "string") return;
					if (method === "Target.attachedToTarget") {
						const attached = params ?? {};
						if ((attached?.targetInfo?.type ?? "page") !== "page") return;
						if (attached?.sessionId && attached?.targetInfo?.targetId) {
							const prev = connectedTargets.get(attached.sessionId);
							const nextTargetId = attached.targetInfo.targetId;
							const prevTargetId = prev?.targetId;
							const changedTarget = Boolean(prev && prevTargetId && prevTargetId !== nextTargetId);
							connectedTargets.set(attached.sessionId, {
								sessionId: attached.sessionId,
								targetId: nextTargetId,
								targetInfo: attached.targetInfo
							});
							if (changedTarget && prevTargetId) broadcastToCdpClients({
								method: "Target.detachedFromTarget",
								params: {
									sessionId: attached.sessionId,
									targetId: prevTargetId
								},
								sessionId: attached.sessionId
							});
							if (!prev || changedTarget) broadcastToCdpClients({
								method,
								params,
								sessionId
							});
							return;
						}
					}
					if (method === "Target.detachedFromTarget") {
						const detached = params ?? {};
						if (detached?.sessionId) dropConnectedTargetSession(detached.sessionId);
						else if (detached?.targetId) dropConnectedTargetsByTargetId(detached.targetId);
						broadcastToCdpClients({
							method,
							params,
							sessionId
						});
						return;
					}
					if (method === "Target.targetDestroyed" || method === "Target.targetCrashed") {
						const targetEvent = params ?? {};
						if (targetEvent.targetId) dropConnectedTargetsByTargetId(targetEvent.targetId);
						broadcastToCdpClients({
							method,
							params,
							sessionId
						});
						return;
					}
					if (method === "Target.targetInfoChanged") {
						const targetInfo = (params ?? {})?.targetInfo;
						const targetId = targetInfo?.targetId;
						if (targetId && (targetInfo?.type ?? "page") === "page") for (const [sid, target] of connectedTargets) {
							if (target.targetId !== targetId) continue;
							connectedTargets.set(sid, {
								...target,
								targetInfo: {
									...target.targetInfo,
									...targetInfo
								}
							});
						}
					}
					broadcastToCdpClients({
						method,
						params,
						sessionId
					});
				}
			});
			ws.on("close", () => {
				clearInterval(ping);
				if (extensionWs !== ws) return;
				extensionWs = null;
				for (const [, pending] of pendingExtension) {
					clearTimeout(pending.timer);
					pending.reject(/* @__PURE__ */ new Error("extension disconnected"));
				}
				pendingExtension.clear();
				scheduleExtensionDisconnectCleanup();
			});
		});
		wssCdp.on("connection", (ws) => {
			cdpClients.add(ws);
			ws.on("message", async (data) => {
				let cmd = null;
				try {
					cmd = JSON.parse(rawDataToString(data));
				} catch {
					return;
				}
				if (!cmd || typeof cmd !== "object") return;
				if (typeof cmd.id !== "number" || typeof cmd.method !== "string") return;
				if (!extensionConnected()) {
					if (!await waitForExtensionReconnect(extensionCommandReconnectWaitMs) || !extensionConnected()) {
						sendResponseToCdp(ws, {
							id: cmd.id,
							sessionId: cmd.sessionId,
							error: { message: "Extension not connected" }
						});
						return;
					}
				}
				try {
					const result = await routeCdpCommand(cmd);
					if (cmd.method === "Target.setAutoAttach" && !cmd.sessionId) ensureTargetEventsForClient(ws, "autoAttach");
					if (cmd.method === "Target.setDiscoverTargets") {
						if ((cmd.params ?? {}).discover === true) ensureTargetEventsForClient(ws, "discover");
					}
					if (cmd.method === "Target.attachToTarget") {
						const params = cmd.params ?? {};
						const targetId = typeof params.targetId === "string" ? params.targetId : void 0;
						if (targetId) {
							const target = Array.from(connectedTargets.values()).find((t) => t.targetId === targetId);
							if (target) ws.send(JSON.stringify({
								method: "Target.attachedToTarget",
								params: {
									sessionId: target.sessionId,
									targetInfo: {
										...target.targetInfo,
										attached: true
									},
									waitingForDebugger: false
								}
							}));
						}
					}
					sendResponseToCdp(ws, {
						id: cmd.id,
						sessionId: cmd.sessionId,
						result
					});
				} catch (err) {
					pruneStaleTargetsFromCommandFailure(cmd, err);
					sendResponseToCdp(ws, {
						id: cmd.id,
						sessionId: cmd.sessionId,
						error: { message: err instanceof Error ? err.message : String(err) }
					});
				}
			});
			ws.on("close", () => {
				cdpClients.delete(ws);
			});
		});
		try {
			await new Promise((resolve, reject) => {
				server.listen(info.port, info.host, () => resolve());
				server.once("error", reject);
			});
		} catch (err) {
			if (isAddrInUseError(err) && await probeAuthenticatedOpenClawRelay({
				baseUrl: info.baseUrl,
				relayAuthHeader: RELAY_AUTH_HEADER,
				relayAuthToken
			})) {
				const existingRelay = {
					host: info.host,
					port: info.port,
					baseUrl: info.baseUrl,
					cdpWsUrl: `ws://${info.host}:${info.port}/cdp`,
					extensionConnected: () => false,
					stop: async () => {
						relayRuntimeByPort.delete(info.port);
					}
				};
				relayRuntimeByPort.set(info.port, {
					server: existingRelay,
					relayAuthToken
				});
				return existingRelay;
			}
			throw err;
		}
		const port = server.address()?.port ?? info.port;
		const host = info.host;
		const relay = {
			host,
			port,
			baseUrl: `${new URL(info.baseUrl).protocol}//${host}:${port}`,
			cdpWsUrl: `ws://${host}:${port}/cdp`,
			extensionConnected,
			stop: async () => {
				relayRuntimeByPort.delete(port);
				clearExtensionDisconnectCleanupTimer();
				flushExtensionReconnectWaiters(false);
				for (const [, pending] of pendingExtension) {
					clearTimeout(pending.timer);
					pending.reject(/* @__PURE__ */ new Error("server stopping"));
				}
				pendingExtension.clear();
				try {
					extensionWs?.close(1001, "server stopping");
				} catch {}
				for (const ws of cdpClients) try {
					ws.close(1001, "server stopping");
				} catch {}
				await new Promise((resolve) => {
					server.close(() => resolve());
				});
				wssExtension.close();
				wssCdp.close();
			}
		};
		relayRuntimeByPort.set(port, {
			server: relay,
			relayAuthToken
		});
		return relay;
	})();
	relayInitByPort.set(info.port, initPromise);
	try {
		return await initPromise;
	} finally {
		relayInitByPort.delete(info.port);
	}
}
async function stopChromeExtensionRelayServer(opts) {
	const info = parseBaseUrl(opts.cdpUrl);
	const existing = relayRuntimeByPort.get(info.port);
	if (!existing) return false;
	await existing.server.stop();
	return true;
}

//#endregion
//#region src/browser/cdp.helpers.ts
function getHeadersWithAuth(url, headers = {}) {
	const mergedHeaders = {
		...getChromeExtensionRelayAuthHeaders(url),
		...headers
	};
	try {
		const parsed = new URL(url);
		if (Object.keys(mergedHeaders).some((key) => key.toLowerCase() === "authorization")) return mergedHeaders;
		if (parsed.username || parsed.password) {
			const auth = Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64");
			return {
				...mergedHeaders,
				Authorization: `Basic ${auth}`
			};
		}
	} catch {}
	return mergedHeaders;
}
function appendCdpPath(cdpUrl, path) {
	const url = new URL(cdpUrl);
	url.pathname = `${url.pathname.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
	return url.toString();
}
function createCdpSender(ws) {
	let nextId = 1;
	const pending = /* @__PURE__ */ new Map();
	const send = (method, params, sessionId) => {
		const id = nextId++;
		const msg = {
			id,
			method,
			params,
			sessionId
		};
		ws.send(JSON.stringify(msg));
		return new Promise((resolve, reject) => {
			pending.set(id, {
				resolve,
				reject
			});
		});
	};
	const closeWithError = (err) => {
		for (const [, p] of pending) p.reject(err);
		pending.clear();
		try {
			ws.close();
		} catch {}
	};
	ws.on("error", (err) => {
		closeWithError(err instanceof Error ? err : new Error(String(err)));
	});
	ws.on("message", (data) => {
		try {
			const parsed = JSON.parse(rawDataToString(data));
			if (typeof parsed.id !== "number") return;
			const p = pending.get(parsed.id);
			if (!p) return;
			pending.delete(parsed.id);
			if (parsed.error?.message) {
				p.reject(new Error(parsed.error.message));
				return;
			}
			p.resolve(parsed.result);
		} catch {}
	});
	ws.on("close", () => {
		closeWithError(/* @__PURE__ */ new Error("CDP socket closed"));
	});
	return {
		send,
		closeWithError
	};
}
async function fetchJson(url, timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS, init) {
	return await (await fetchCdpChecked(url, timeoutMs, init)).json();
}
async function fetchCdpChecked(url, timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS, init) {
	const ctrl = new AbortController();
	const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
	try {
		const headers = getHeadersWithAuth(url, init?.headers || {});
		const res = await withNoProxyForCdpUrl(url, () => fetch(url, {
			...init,
			headers,
			signal: ctrl.signal
		}));
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res;
	} finally {
		clearTimeout(t);
	}
}
async function fetchOk(url, timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS, init) {
	await fetchCdpChecked(url, timeoutMs, init);
}
function openCdpWebSocket(wsUrl, opts) {
	const headers = getHeadersWithAuth(wsUrl, opts?.headers ?? {});
	const handshakeTimeoutMs = typeof opts?.handshakeTimeoutMs === "number" && Number.isFinite(opts.handshakeTimeoutMs) ? Math.max(1, Math.floor(opts.handshakeTimeoutMs)) : CDP_WS_HANDSHAKE_TIMEOUT_MS;
	const agent = getDirectAgentForCdp(wsUrl);
	return new WebSocket(wsUrl, {
		handshakeTimeout: handshakeTimeoutMs,
		...Object.keys(headers).length ? { headers } : {},
		...agent ? { agent } : {}
	});
}
async function withCdpSocket(wsUrl, fn, opts) {
	const ws = openCdpWebSocket(wsUrl, opts);
	const { send, closeWithError } = createCdpSender(ws);
	const openPromise = new Promise((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", (err) => reject(err));
		ws.once("close", () => reject(/* @__PURE__ */ new Error("CDP socket closed")));
	});
	try {
		await openPromise;
	} catch (err) {
		closeWithError(err instanceof Error ? err : new Error(String(err)));
		throw err;
	}
	try {
		return await fn(send);
	} catch (err) {
		closeWithError(err instanceof Error ? err : new Error(String(err)));
		throw err;
	} finally {
		try {
			ws.close();
		} catch {}
	}
}

//#endregion
//#region src/browser/navigation-guard.ts
const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);
function isAllowedNonNetworkNavigationUrl(parsed) {
	return SAFE_NON_NETWORK_URLS.has(parsed.href);
}
var InvalidBrowserNavigationUrlError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "InvalidBrowserNavigationUrlError";
	}
};
function withBrowserNavigationPolicy(ssrfPolicy) {
	return ssrfPolicy ? { ssrfPolicy } : {};
}
async function assertBrowserNavigationAllowed(opts) {
	if (isDevMode()) return;
	const rawUrl = String(opts.url ?? "").trim();
	if (!rawUrl) throw new InvalidBrowserNavigationUrlError("url is required");
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${rawUrl}`);
	}
	if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
		if (isAllowedNonNetworkNavigationUrl(parsed)) return;
		throw new InvalidBrowserNavigationUrlError(`Navigation blocked: unsupported protocol "${parsed.protocol}"`);
	}
	if (hasProxyEnvConfigured() && !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)) throw new InvalidBrowserNavigationUrlError("Navigation blocked: strict browser SSRF policy cannot be enforced while env proxy variables are set");
	await resolvePinnedHostnameWithPolicy(parsed.hostname, {
		lookupFn: opts.lookupFn,
		policy: opts.ssrfPolicy
	});
}
/**
* Best-effort post-navigation guard for final page URLs.
* Only validates network URLs (http/https) and about:blank to avoid false
* positives on browser-internal error pages (e.g. chrome-error://).
*/
async function assertBrowserNavigationResultAllowed(opts) {
	const rawUrl = String(opts.url ?? "").trim();
	if (!rawUrl) return;
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return;
	}
	if (NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) || isAllowedNonNetworkNavigationUrl(parsed)) await assertBrowserNavigationAllowed(opts);
}

//#endregion
//#region src/browser/cdp.ts
function normalizeCdpWsUrl(wsUrl, cdpUrl) {
	const ws = new URL(wsUrl);
	const cdp = new URL(cdpUrl);
	if (isLoopbackHost(ws.hostname) && !isLoopbackHost(cdp.hostname)) {
		ws.hostname = cdp.hostname;
		const cdpPort = cdp.port || (cdp.protocol === "https:" ? "443" : "80");
		if (cdpPort) ws.port = cdpPort;
		ws.protocol = cdp.protocol === "https:" ? "wss:" : "ws:";
	}
	if (cdp.protocol === "https:" && ws.protocol === "ws:") ws.protocol = "wss:";
	if (!ws.username && !ws.password && (cdp.username || cdp.password)) {
		ws.username = cdp.username;
		ws.password = cdp.password;
	}
	for (const [key, value] of cdp.searchParams.entries()) if (!ws.searchParams.has(key)) ws.searchParams.append(key, value);
	return ws.toString();
}
async function captureScreenshot(opts) {
	return await withCdpSocket(opts.wsUrl, async (send) => {
		await send("Page.enable");
		let clip;
		if (opts.fullPage) {
			const metrics = await send("Page.getLayoutMetrics");
			const size = metrics?.cssContentSize ?? metrics?.contentSize;
			const width = Number(size?.width ?? 0);
			const height = Number(size?.height ?? 0);
			if (width > 0 && height > 0) clip = {
				x: 0,
				y: 0,
				width,
				height,
				scale: 1
			};
		}
		const format = opts.format ?? "png";
		const quality = format === "jpeg" ? Math.max(0, Math.min(100, Math.round(opts.quality ?? 85))) : void 0;
		const base64 = (await send("Page.captureScreenshot", {
			format,
			...quality !== void 0 ? { quality } : {},
			fromSurface: true,
			captureBeyondViewport: true,
			...clip ? { clip } : {}
		}))?.data;
		if (!base64) throw new Error("Screenshot failed: missing data");
		return Buffer.from(base64, "base64");
	});
}
async function createTargetViaCdp(opts) {
	await assertBrowserNavigationAllowed({
		url: opts.url,
		...withBrowserNavigationPolicy(opts.ssrfPolicy)
	});
	const version = await fetchJson(appendCdpPath(opts.cdpUrl, "/json/version"), 1500);
	const wsUrlRaw = String(version?.webSocketDebuggerUrl ?? "").trim();
	const wsUrl = wsUrlRaw ? normalizeCdpWsUrl(wsUrlRaw, opts.cdpUrl) : "";
	if (!wsUrl) throw new Error("CDP /json/version missing webSocketDebuggerUrl");
	return await withCdpSocket(wsUrl, async (send) => {
		const created = await send("Target.createTarget", { url: opts.url });
		const targetId = String(created?.targetId ?? "").trim();
		if (!targetId) throw new Error("CDP Target.createTarget returned no targetId");
		return { targetId };
	});
}
function axValue(v) {
	if (!v || typeof v !== "object") return "";
	const value = v.value;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}
function formatAriaSnapshot(nodes, limit) {
	const byId = /* @__PURE__ */ new Map();
	for (const n of nodes) if (n.nodeId) byId.set(n.nodeId, n);
	const referenced = /* @__PURE__ */ new Set();
	for (const n of nodes) for (const c of n.childIds ?? []) referenced.add(c);
	const root = nodes.find((n) => n.nodeId && !referenced.has(n.nodeId)) ?? nodes[0];
	if (!root?.nodeId) return [];
	const out = [];
	const stack = [{
		id: root.nodeId,
		depth: 0
	}];
	while (stack.length && out.length < limit) {
		const popped = stack.pop();
		if (!popped) break;
		const { id, depth } = popped;
		const n = byId.get(id);
		if (!n) continue;
		const role = axValue(n.role);
		const name = axValue(n.name);
		const value = axValue(n.value);
		const description = axValue(n.description);
		const ref = `ax${out.length + 1}`;
		out.push({
			ref,
			role: role || "unknown",
			name: name || "",
			...value ? { value } : {},
			...description ? { description } : {},
			...typeof n.backendDOMNodeId === "number" ? { backendDOMNodeId: n.backendDOMNodeId } : {},
			depth
		});
		const children = (n.childIds ?? []).filter((c) => byId.has(c));
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			if (child) stack.push({
				id: child,
				depth: depth + 1
			});
		}
	}
	return out;
}
async function snapshotAria(opts) {
	const limit = Math.max(1, Math.min(2e3, Math.floor(opts.limit ?? 500)));
	return await withCdpSocket(opts.wsUrl, async (send) => {
		await send("Accessibility.enable").catch(() => {});
		const res = await send("Accessibility.getFullAXTree");
		return { nodes: formatAriaSnapshot(Array.isArray(res?.nodes) ? res.nodes : [], limit) };
	});
}

//#endregion
//#region src/browser/chrome.executables.ts
const CHROMIUM_BUNDLE_IDS = new Set([
	"com.google.Chrome",
	"com.google.Chrome.beta",
	"com.google.Chrome.canary",
	"com.google.Chrome.dev",
	"com.brave.Browser",
	"com.brave.Browser.beta",
	"com.brave.Browser.nightly",
	"com.microsoft.Edge",
	"com.microsoft.EdgeBeta",
	"com.microsoft.EdgeDev",
	"com.microsoft.EdgeCanary",
	"org.chromium.Chromium",
	"com.vivaldi.Vivaldi",
	"com.operasoftware.Opera",
	"com.operasoftware.OperaGX",
	"com.yandex.desktop.yandex-browser",
	"company.thebrowser.Browser"
]);
const CHROMIUM_DESKTOP_IDS = new Set([
	"google-chrome.desktop",
	"google-chrome-beta.desktop",
	"google-chrome-unstable.desktop",
	"brave-browser.desktop",
	"microsoft-edge.desktop",
	"microsoft-edge-beta.desktop",
	"microsoft-edge-dev.desktop",
	"microsoft-edge-canary.desktop",
	"chromium.desktop",
	"chromium-browser.desktop",
	"vivaldi.desktop",
	"vivaldi-stable.desktop",
	"opera.desktop",
	"opera-gx.desktop",
	"yandex-browser.desktop",
	"org.chromium.Chromium.desktop"
]);
const CHROMIUM_EXE_NAMES = new Set([
	"chrome.exe",
	"msedge.exe",
	"brave.exe",
	"brave-browser.exe",
	"chromium.exe",
	"vivaldi.exe",
	"opera.exe",
	"launcher.exe",
	"yandex.exe",
	"yandexbrowser.exe",
	"google chrome",
	"google chrome canary",
	"brave browser",
	"microsoft edge",
	"chromium",
	"chrome",
	"brave",
	"msedge",
	"brave-browser",
	"google-chrome",
	"google-chrome-stable",
	"google-chrome-beta",
	"google-chrome-unstable",
	"microsoft-edge",
	"microsoft-edge-beta",
	"microsoft-edge-dev",
	"microsoft-edge-canary",
	"chromium-browser",
	"vivaldi",
	"vivaldi-stable",
	"opera",
	"opera-stable",
	"opera-gx",
	"yandex-browser"
]);
function exists$1(filePath) {
	try {
		return fs$1.existsSync(filePath);
	} catch {
		return false;
	}
}
function execText(command, args, timeoutMs = 1200, maxBuffer = 1024 * 1024) {
	try {
		const output = execFileSync(command, args, {
			timeout: timeoutMs,
			encoding: "utf8",
			maxBuffer
		});
		return String(output ?? "").trim() || null;
	} catch {
		return null;
	}
}
function inferKindFromIdentifier(identifier) {
	const id = identifier.toLowerCase();
	if (id.includes("brave")) return "brave";
	if (id.includes("edge")) return "edge";
	if (id.includes("chromium")) return "chromium";
	if (id.includes("canary")) return "canary";
	if (id.includes("opera") || id.includes("vivaldi") || id.includes("yandex") || id.includes("thebrowser")) return "chromium";
	return "chrome";
}
function inferKindFromExecutableName(name) {
	const lower = name.toLowerCase();
	if (lower.includes("brave")) return "brave";
	if (lower.includes("edge") || lower.includes("msedge")) return "edge";
	if (lower.includes("chromium")) return "chromium";
	if (lower.includes("canary") || lower.includes("sxs")) return "canary";
	if (lower.includes("opera") || lower.includes("vivaldi") || lower.includes("yandex")) return "chromium";
	return "chrome";
}
function detectDefaultChromiumExecutable(platform) {
	if (platform === "darwin") return detectDefaultChromiumExecutableMac();
	if (platform === "linux") return detectDefaultChromiumExecutableLinux();
	if (platform === "win32") return detectDefaultChromiumExecutableWindows();
	return null;
}
function detectDefaultChromiumExecutableMac() {
	const bundleId = detectDefaultBrowserBundleIdMac();
	if (!bundleId || !CHROMIUM_BUNDLE_IDS.has(bundleId)) return null;
	const appPathRaw = execText("/usr/bin/osascript", ["-e", `POSIX path of (path to application id "${bundleId}")`]);
	if (!appPathRaw) return null;
	const appPath = appPathRaw.trim().replace(/\/$/, "");
	const exeName = execText("/usr/bin/defaults", [
		"read",
		path.join(appPath, "Contents", "Info"),
		"CFBundleExecutable"
	]);
	if (!exeName) return null;
	const exePath = path.join(appPath, "Contents", "MacOS", exeName.trim());
	if (!exists$1(exePath)) return null;
	return {
		kind: inferKindFromIdentifier(bundleId),
		path: exePath
	};
}
function detectDefaultBrowserBundleIdMac() {
	const plistPath = path.join(os.homedir(), "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
	if (!exists$1(plistPath)) return null;
	const handlersRaw = execText("/usr/bin/plutil", [
		"-extract",
		"LSHandlers",
		"json",
		"-o",
		"-",
		"--",
		plistPath
	], 2e3, 5 * 1024 * 1024);
	if (!handlersRaw) return null;
	let handlers;
	try {
		handlers = JSON.parse(handlersRaw);
	} catch {
		return null;
	}
	if (!Array.isArray(handlers)) return null;
	const resolveScheme = (scheme) => {
		let candidate = null;
		for (const entry of handlers) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry;
			if (record.LSHandlerURLScheme !== scheme) continue;
			const role = typeof record.LSHandlerRoleAll === "string" && record.LSHandlerRoleAll || typeof record.LSHandlerRoleViewer === "string" && record.LSHandlerRoleViewer || null;
			if (role) candidate = role;
		}
		return candidate;
	};
	return resolveScheme("http") ?? resolveScheme("https");
}
function detectDefaultChromiumExecutableLinux() {
	const desktopId = execText("xdg-settings", ["get", "default-web-browser"]) || execText("xdg-mime", [
		"query",
		"default",
		"x-scheme-handler/http"
	]);
	if (!desktopId) return null;
	const trimmed = desktopId.trim();
	if (!CHROMIUM_DESKTOP_IDS.has(trimmed)) return null;
	const desktopPath = findDesktopFilePath(trimmed);
	if (!desktopPath) return null;
	const execLine = readDesktopExecLine(desktopPath);
	if (!execLine) return null;
	const command = extractExecutableFromExecLine(execLine);
	if (!command) return null;
	const resolved = resolveLinuxExecutablePath(command);
	if (!resolved) return null;
	const exeName = path.posix.basename(resolved).toLowerCase();
	if (!CHROMIUM_EXE_NAMES.has(exeName)) return null;
	return {
		kind: inferKindFromExecutableName(exeName),
		path: resolved
	};
}
function detectDefaultChromiumExecutableWindows() {
	const progId = readWindowsProgId();
	const command = (progId ? readWindowsCommandForProgId(progId) : null) || readWindowsCommandForProgId("http");
	if (!command) return null;
	const exePath = extractWindowsExecutablePath(expandWindowsEnvVars(command));
	if (!exePath) return null;
	if (!exists$1(exePath)) return null;
	const exeName = path.win32.basename(exePath).toLowerCase();
	if (!CHROMIUM_EXE_NAMES.has(exeName)) return null;
	return {
		kind: inferKindFromExecutableName(exeName),
		path: exePath
	};
}
function findDesktopFilePath(desktopId) {
	const candidates = [
		path.join(os.homedir(), ".local", "share", "applications", desktopId),
		path.join("/usr/local/share/applications", desktopId),
		path.join("/usr/share/applications", desktopId),
		path.join("/var/lib/snapd/desktop/applications", desktopId)
	];
	for (const candidate of candidates) if (exists$1(candidate)) return candidate;
	return null;
}
function readDesktopExecLine(desktopPath) {
	try {
		const lines = fs$1.readFileSync(desktopPath, "utf8").split(/\r?\n/);
		for (const line of lines) if (line.startsWith("Exec=")) return line.slice(5).trim();
	} catch {}
	return null;
}
function extractExecutableFromExecLine(execLine) {
	const tokens = splitExecLine(execLine);
	for (const token of tokens) {
		if (!token) continue;
		if (token === "env") continue;
		if (token.includes("=") && !token.startsWith("/") && !token.includes("\\")) continue;
		return token.replace(/^["']|["']$/g, "");
	}
	return null;
}
function splitExecLine(line) {
	const tokens = [];
	let current = "";
	let inQuotes = false;
	let quoteChar = "";
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if ((ch === "\"" || ch === "'") && (!inQuotes || ch === quoteChar)) {
			if (inQuotes) {
				inQuotes = false;
				quoteChar = "";
			} else {
				inQuotes = true;
				quoteChar = ch;
			}
			continue;
		}
		if (!inQuotes && /\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}
function resolveLinuxExecutablePath(command) {
	const cleaned = command.trim().replace(/%[a-zA-Z]/g, "");
	if (!cleaned) return null;
	if (cleaned.startsWith("/")) return cleaned;
	const resolved = execText("which", [cleaned], 800);
	return resolved ? resolved.trim() : null;
}
function readWindowsProgId() {
	const output = execText("reg", [
		"query",
		"HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice",
		"/v",
		"ProgId"
	]);
	if (!output) return null;
	return output.match(/ProgId\s+REG_\w+\s+(.+)$/im)?.[1]?.trim() || null;
}
function readWindowsCommandForProgId(progId) {
	const output = execText("reg", [
		"query",
		progId === "http" ? "HKCR\\http\\shell\\open\\command" : `HKCR\\${progId}\\shell\\open\\command`,
		"/ve"
	]);
	if (!output) return null;
	return output.match(/REG_\w+\s+(.+)$/im)?.[1]?.trim() || null;
}
function expandWindowsEnvVars(value) {
	return value.replace(/%([^%]+)%/g, (_match, name) => {
		const key = String(name ?? "").trim();
		return key ? process.env[key] ?? `%${key}%` : _match;
	});
}
function extractWindowsExecutablePath(command) {
	const quoted = command.match(/"([^"]+\\.exe)"/i);
	if (quoted?.[1]) return quoted[1];
	const unquoted = command.match(/([^\\s]+\\.exe)/i);
	if (unquoted?.[1]) return unquoted[1];
	return null;
}
function findFirstExecutable(candidates) {
	for (const candidate of candidates) if (exists$1(candidate.path)) return candidate;
	return null;
}
function findChromeExecutableMac() {
	return findFirstExecutable([
		{
			kind: "chrome",
			path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		},
		{
			kind: "chrome",
			path: path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
		},
		{
			kind: "brave",
			path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
		},
		{
			kind: "brave",
			path: path.join(os.homedir(), "Applications/Brave Browser.app/Contents/MacOS/Brave Browser")
		},
		{
			kind: "edge",
			path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
		},
		{
			kind: "edge",
			path: path.join(os.homedir(), "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
		},
		{
			kind: "chromium",
			path: "/Applications/Chromium.app/Contents/MacOS/Chromium"
		},
		{
			kind: "chromium",
			path: path.join(os.homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium")
		},
		{
			kind: "canary",
			path: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
		},
		{
			kind: "canary",
			path: path.join(os.homedir(), "Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary")
		}
	]);
}
function findChromeExecutableLinux() {
	return findFirstExecutable([
		{
			kind: "chrome",
			path: "/usr/bin/google-chrome"
		},
		{
			kind: "chrome",
			path: "/usr/bin/google-chrome-stable"
		},
		{
			kind: "chrome",
			path: "/usr/bin/chrome"
		},
		{
			kind: "brave",
			path: "/usr/bin/brave-browser"
		},
		{
			kind: "brave",
			path: "/usr/bin/brave-browser-stable"
		},
		{
			kind: "brave",
			path: "/usr/bin/brave"
		},
		{
			kind: "brave",
			path: "/snap/bin/brave"
		},
		{
			kind: "edge",
			path: "/usr/bin/microsoft-edge"
		},
		{
			kind: "edge",
			path: "/usr/bin/microsoft-edge-stable"
		},
		{
			kind: "chromium",
			path: "/usr/bin/chromium"
		},
		{
			kind: "chromium",
			path: "/usr/bin/chromium-browser"
		},
		{
			kind: "chromium",
			path: "/snap/bin/chromium"
		}
	]);
}
function findChromeExecutableWindows() {
	const localAppData = process.env.LOCALAPPDATA ?? "";
	const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
	const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	const joinWin = path.win32.join;
	const candidates = [];
	if (localAppData) {
		candidates.push({
			kind: "chrome",
			path: joinWin(localAppData, "Google", "Chrome", "Application", "chrome.exe")
		});
		candidates.push({
			kind: "brave",
			path: joinWin(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
		});
		candidates.push({
			kind: "edge",
			path: joinWin(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")
		});
		candidates.push({
			kind: "chromium",
			path: joinWin(localAppData, "Chromium", "Application", "chrome.exe")
		});
		candidates.push({
			kind: "canary",
			path: joinWin(localAppData, "Google", "Chrome SxS", "Application", "chrome.exe")
		});
	}
	candidates.push({
		kind: "chrome",
		path: joinWin(programFiles, "Google", "Chrome", "Application", "chrome.exe")
	});
	candidates.push({
		kind: "chrome",
		path: joinWin(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
	});
	candidates.push({
		kind: "brave",
		path: joinWin(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
	});
	candidates.push({
		kind: "brave",
		path: joinWin(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
	});
	candidates.push({
		kind: "edge",
		path: joinWin(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")
	});
	candidates.push({
		kind: "edge",
		path: joinWin(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")
	});
	return findFirstExecutable(candidates);
}
function resolveBrowserExecutableForPlatform(resolved, platform) {
	if (resolved.executablePath) {
		if (!exists$1(resolved.executablePath)) throw new Error(`browser.executablePath not found: ${resolved.executablePath}`);
		return {
			kind: "custom",
			path: resolved.executablePath
		};
	}
	const detected = detectDefaultChromiumExecutable(platform);
	if (detected) return detected;
	if (platform === "darwin") return findChromeExecutableMac();
	if (platform === "linux") return findChromeExecutableLinux();
	if (platform === "win32") return findChromeExecutableWindows();
	return null;
}

//#endregion
//#region src/infra/ports-lsof.ts
const LSOF_CANDIDATES = process.platform === "darwin" ? ["/usr/sbin/lsof", "/usr/bin/lsof"] : ["/usr/bin/lsof", "/usr/sbin/lsof"];
function resolveLsofCommandSync() {
	for (const candidate of LSOF_CANDIDATES) try {
		fs$1.accessSync(candidate, fs$1.constants.X_OK);
		return candidate;
	} catch {}
	return "lsof";
}

//#endregion
//#region src/infra/ports-probe.ts
async function tryListenOnPort(params) {
	const listenOptions = { port: params.port };
	if (params.host) listenOptions.host = params.host;
	if (typeof params.exclusive === "boolean") listenOptions.exclusive = params.exclusive;
	await new Promise((resolve, reject) => {
		const tester = net.createServer().once("error", (err) => reject(err)).once("listening", () => {
			tester.close(() => resolve());
		}).listen(listenOptions);
	});
}

//#endregion
//#region src/infra/ports.ts
var PortInUseError = class extends Error {
	constructor(port, details) {
		super(`Port ${port} is already in use.`);
		this.name = "PortInUseError";
		this.port = port;
		this.details = details;
	}
};
async function ensurePortAvailable(port) {
	try {
		await tryListenOnPort({ port });
	} catch (err) {
		if (isErrno(err) && err.code === "EADDRINUSE") throw new PortInUseError(port);
		throw err;
	}
}

//#endregion
//#region src/browser/chrome.profile-decoration.ts
function decoratedMarkerPath(userDataDir) {
	return path.join(userDataDir, ".openclaw-profile-decorated");
}
function safeReadJson(filePath) {
	try {
		if (!fs$1.existsSync(filePath)) return null;
		const raw = fs$1.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}
function safeWriteJson(filePath, data) {
	fs$1.mkdirSync(path.dirname(filePath), { recursive: true });
	fs$1.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
function setDeep(obj, keys, value) {
	let node = obj;
	for (const key of keys.slice(0, -1)) {
		const next = node[key];
		if (typeof next !== "object" || next === null || Array.isArray(next)) node[key] = {};
		node = node[key];
	}
	node[keys[keys.length - 1] ?? ""] = value;
}
function parseHexRgbToSignedArgbInt(hex) {
	const cleaned = hex.trim().replace(/^#/, "");
	if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
	const argbUnsigned = 255 << 24 | Number.parseInt(cleaned, 16);
	return argbUnsigned > 2147483647 ? argbUnsigned - 4294967296 : argbUnsigned;
}
function isProfileDecorated(userDataDir, desiredName, desiredColorHex) {
	const desiredColorInt = parseHexRgbToSignedArgbInt(desiredColorHex);
	const localStatePath = path.join(userDataDir, "Local State");
	const preferencesPath = path.join(userDataDir, "Default", "Preferences");
	const profile = safeReadJson(localStatePath)?.profile;
	const infoCache = typeof profile === "object" && profile !== null && !Array.isArray(profile) ? profile.info_cache : null;
	const info = typeof infoCache === "object" && infoCache !== null && !Array.isArray(infoCache) && typeof infoCache.Default === "object" && infoCache.Default !== null && !Array.isArray(infoCache.Default) ? infoCache.Default : null;
	const prefs = safeReadJson(preferencesPath);
	const browserTheme = (() => {
		const browser = prefs?.browser;
		const theme = typeof browser === "object" && browser !== null && !Array.isArray(browser) ? browser.theme : null;
		return typeof theme === "object" && theme !== null && !Array.isArray(theme) ? theme : null;
	})();
	const autogeneratedTheme = (() => {
		const autogenerated = prefs?.autogenerated;
		const theme = typeof autogenerated === "object" && autogenerated !== null && !Array.isArray(autogenerated) ? autogenerated.theme : null;
		return typeof theme === "object" && theme !== null && !Array.isArray(theme) ? theme : null;
	})();
	const nameOk = typeof info?.name === "string" ? info.name === desiredName : true;
	if (desiredColorInt == null) return nameOk;
	const localSeedOk = typeof info?.profile_color_seed === "number" ? info.profile_color_seed === desiredColorInt : false;
	const prefOk = typeof browserTheme?.user_color2 === "number" && browserTheme.user_color2 === desiredColorInt || typeof autogeneratedTheme?.color === "number" && autogeneratedTheme.color === desiredColorInt;
	return nameOk && localSeedOk && prefOk;
}
/**
* Best-effort profile decoration (name + lobster-orange). Chrome preference keys
* vary by version; we keep this conservative and idempotent.
*/
function decorateOpenClawProfile(userDataDir, opts) {
	const desiredName = opts?.name ?? DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME;
	const desiredColor = (opts?.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase();
	const desiredColorInt = parseHexRgbToSignedArgbInt(desiredColor);
	const localStatePath = path.join(userDataDir, "Local State");
	const preferencesPath = path.join(userDataDir, "Default", "Preferences");
	const localState = safeReadJson(localStatePath) ?? {};
	setDeep(localState, [
		"profile",
		"info_cache",
		"Default",
		"name"
	], desiredName);
	setDeep(localState, [
		"profile",
		"info_cache",
		"Default",
		"shortcut_name"
	], desiredName);
	setDeep(localState, [
		"profile",
		"info_cache",
		"Default",
		"user_name"
	], desiredName);
	setDeep(localState, [
		"profile",
		"info_cache",
		"Default",
		"profile_color"
	], desiredColor);
	setDeep(localState, [
		"profile",
		"info_cache",
		"Default",
		"user_color"
	], desiredColor);
	if (desiredColorInt != null) {
		setDeep(localState, [
			"profile",
			"info_cache",
			"Default",
			"profile_color_seed"
		], desiredColorInt);
		setDeep(localState, [
			"profile",
			"info_cache",
			"Default",
			"profile_highlight_color"
		], desiredColorInt);
		setDeep(localState, [
			"profile",
			"info_cache",
			"Default",
			"default_avatar_fill_color"
		], desiredColorInt);
		setDeep(localState, [
			"profile",
			"info_cache",
			"Default",
			"default_avatar_stroke_color"
		], desiredColorInt);
	}
	safeWriteJson(localStatePath, localState);
	const prefs = safeReadJson(preferencesPath) ?? {};
	setDeep(prefs, ["profile", "name"], desiredName);
	setDeep(prefs, ["profile", "profile_color"], desiredColor);
	setDeep(prefs, ["profile", "user_color"], desiredColor);
	if (desiredColorInt != null) {
		setDeep(prefs, [
			"autogenerated",
			"theme",
			"color"
		], desiredColorInt);
		setDeep(prefs, [
			"browser",
			"theme",
			"user_color2"
		], desiredColorInt);
	}
	safeWriteJson(preferencesPath, prefs);
	try {
		fs$1.writeFileSync(decoratedMarkerPath(userDataDir), `${Date.now()}\n`, "utf-8");
	} catch {}
}
function ensureProfileCleanExit(userDataDir) {
	const preferencesPath = path.join(userDataDir, "Default", "Preferences");
	const prefs = safeReadJson(preferencesPath) ?? {};
	setDeep(prefs, ["exit_type"], "Normal");
	setDeep(prefs, ["exited_cleanly"], true);
	safeWriteJson(preferencesPath, prefs);
}

//#endregion
//#region src/browser/chrome.ts
const log = createSubsystemLogger("browser").child("chrome");
function exists(filePath) {
	try {
		return fs$1.existsSync(filePath);
	} catch {
		return false;
	}
}
function resolveBrowserExecutable(resolved) {
	return resolveBrowserExecutableForPlatform(resolved, process.platform);
}
function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
	return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}
function cdpUrlForPort(cdpPort) {
	return `http://127.0.0.1:${cdpPort}`;
}
async function isChromeReachable(cdpUrl, timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS) {
	const version = await fetchChromeVersion(cdpUrl, timeoutMs);
	return Boolean(version);
}
async function fetchChromeVersion(cdpUrl, timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS) {
	const ctrl = new AbortController();
	const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
	try {
		const data = await (await fetchCdpChecked(appendCdpPath(cdpUrl, "/json/version"), timeoutMs, { signal: ctrl.signal })).json();
		if (!data || typeof data !== "object") return null;
		return data;
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}
async function getChromeWebSocketUrl(cdpUrl, timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS) {
	const version = await fetchChromeVersion(cdpUrl, timeoutMs);
	const wsUrl = String(version?.webSocketDebuggerUrl ?? "").trim();
	if (!wsUrl) return null;
	return normalizeCdpWsUrl(wsUrl, cdpUrl);
}
async function canRunCdpHealthCommand(wsUrl, timeoutMs = CHROME_WS_READY_TIMEOUT_MS) {
	return await new Promise((resolve) => {
		const ws = openCdpWebSocket(wsUrl, { handshakeTimeoutMs: timeoutMs });
		let settled = false;
		const onMessage = (raw) => {
			if (settled) return;
			let parsed = null;
			try {
				parsed = JSON.parse(rawDataToString(raw));
			} catch {
				return;
			}
			if (parsed?.id !== 1) return;
			finish(Boolean(parsed.result && typeof parsed.result === "object"));
		};
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ws.off("message", onMessage);
			try {
				ws.close();
			} catch {}
			resolve(value);
		};
		const timer = setTimeout(() => {
			try {
				ws.terminate();
			} catch {}
			finish(false);
		}, Math.max(50, timeoutMs + 25));
		ws.once("open", () => {
			try {
				ws.send(JSON.stringify({
					id: 1,
					method: "Browser.getVersion"
				}));
			} catch {
				finish(false);
			}
		});
		ws.on("message", onMessage);
		ws.once("error", () => {
			finish(false);
		});
		ws.once("close", () => {
			finish(false);
		});
	});
}
async function isChromeCdpReady(cdpUrl, timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS, handshakeTimeoutMs = CHROME_WS_READY_TIMEOUT_MS) {
	const wsUrl = await getChromeWebSocketUrl(cdpUrl, timeoutMs);
	if (!wsUrl) return false;
	return await canRunCdpHealthCommand(wsUrl, handshakeTimeoutMs);
}
async function launchOpenClawChrome(resolved, profile) {
	if (!profile.cdpIsLoopback) throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
	await ensurePortAvailable(profile.cdpPort);
	const exe = resolveBrowserExecutable(resolved);
	if (!exe) throw new Error("No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).");
	const userDataDir = resolveOpenClawUserDataDir(profile.name);
	fs$1.mkdirSync(userDataDir, { recursive: true });
	const needsDecorate = !isProfileDecorated(userDataDir, profile.name, (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase());
	const spawnOnce = () => {
		const args = [
			`--remote-debugging-port=${profile.cdpPort}`,
			`--user-data-dir=${userDataDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-sync",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-features=Translate,MediaRouter",
			"--disable-session-crashed-bubble",
			"--hide-crash-restore-bubble",
			"--password-store=basic"
		];
		if (resolved.headless) {
			args.push("--headless=new");
			args.push("--disable-gpu");
		}
		if (resolved.noSandbox) {
			args.push("--no-sandbox");
			args.push("--disable-setuid-sandbox");
		}
		if (process.platform === "linux") args.push("--disable-dev-shm-usage");
		if (resolved.extraArgs.length > 0) args.push(...resolved.extraArgs);
		args.push("about:blank");
		return spawn(exe.path, args, {
			stdio: "pipe",
			env: {
				...process.env,
				HOME: os.homedir()
			}
		});
	};
	const startedAt = Date.now();
	const localStatePath = path.join(userDataDir, "Local State");
	const preferencesPath = path.join(userDataDir, "Default", "Preferences");
	if (!exists(localStatePath) || !exists(preferencesPath)) {
		const bootstrap = spawnOnce();
		const deadline = Date.now() + CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (exists(localStatePath) && exists(preferencesPath)) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		try {
			bootstrap.kill("SIGTERM");
		} catch {}
		const exitDeadline = Date.now() + CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS;
		while (Date.now() < exitDeadline) {
			if (bootstrap.exitCode != null) break;
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	if (needsDecorate) try {
		decorateOpenClawProfile(userDataDir, {
			name: profile.name,
			color: profile.color
		});
		log.info(`🦞 openclaw browser profile decorated (${profile.color})`);
	} catch (err) {
		log.warn(`openclaw browser profile decoration failed: ${String(err)}`);
	}
	try {
		ensureProfileCleanExit(userDataDir);
	} catch (err) {
		log.warn(`openclaw browser clean-exit prefs failed: ${String(err)}`);
	}
	const proc = spawnOnce();
	const stderrChunks = [];
	const onStderr = (chunk) => {
		stderrChunks.push(chunk);
	};
	proc.stderr?.on("data", onStderr);
	const readyDeadline = Date.now() + CHROME_LAUNCH_READY_WINDOW_MS;
	while (Date.now() < readyDeadline) {
		if (await isChromeReachable(profile.cdpUrl)) break;
		await new Promise((r) => setTimeout(r, CHROME_LAUNCH_READY_POLL_MS));
	}
	if (!await isChromeReachable(profile.cdpUrl)) {
		const stderrOutput = Buffer.concat(stderrChunks).toString("utf8").trim();
		const stderrHint = stderrOutput ? `\nChrome stderr:\n${stderrOutput.slice(0, CHROME_STDERR_HINT_MAX_CHARS)}` : "";
		const sandboxHint = process.platform === "linux" && !resolved.noSandbox ? "\nHint: If running in a container or as root, try setting browser.noSandbox: true in config." : "";
		try {
			proc.kill("SIGKILL");
		} catch {}
		throw new Error(`Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".${sandboxHint}${stderrHint}`);
	}
	proc.stderr?.off("data", onStderr);
	stderrChunks.length = 0;
	const pid = proc.pid ?? -1;
	log.info(`🦞 openclaw browser started (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`);
	return {
		pid,
		exe,
		userDataDir,
		cdpPort: profile.cdpPort,
		startedAt,
		proc
	};
}
async function stopOpenClawChrome(running, timeoutMs = CHROME_STOP_TIMEOUT_MS) {
	const proc = running.proc;
	if (proc.killed) return;
	try {
		proc.kill("SIGTERM");
	} catch {}
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!proc.exitCode && proc.killed) break;
		if (!await isChromeReachable(cdpUrlForPort(running.cdpPort), CHROME_STOP_PROBE_TIMEOUT_MS)) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	try {
		proc.kill("SIGKILL");
	} catch {}
}

//#endregion
export { rawDataToString as A, isSecureWebSocketUrl as B, ensureChromeExtensionRelayServer as C, PROFILE_POST_RESTART_WS_TIMEOUT_MS as D, PROFILE_ATTACH_RETRY_TIMEOUT_MS as E, resolveStrictExistingPathsWithinRoot as F, DEFAULT_BROWSER_EVALUATE_ENABLED as G, DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS as H, resolveWritablePathWithinRoot as I, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME as J, DEFAULT_OPENCLAW_BROWSER_COLOR as K, DEFAULT_FILL_FIELD_TYPE as L, DEFAULT_TRACE_DIR as M, DEFAULT_UPLOAD_DIR as N, resolveCdpReachabilityTimeouts as O, resolveExistingPathsWithinRoot as P, normalizeBrowserFormField as R, withCdpSocket as S, CDP_JSON_NEW_TIMEOUT_MS as T, DEFAULT_AI_SNAPSHOT_MAX_CHARS as U, DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH as V, DEFAULT_BROWSER_DEFAULT_PROFILE_NAME as W, withBrowserNavigationPolicy as _, resolveOpenClawUserDataDir as a, fetchOk as b, resolveBrowserExecutableForPlatform as c, formatAriaSnapshot as d, normalizeCdpWsUrl as f, assertBrowserNavigationResultAllowed as g, assertBrowserNavigationAllowed as h, launchOpenClawChrome as i, DEFAULT_DOWNLOAD_DIR as j, withNoProxyForCdpUrl as k, captureScreenshot as l, InvalidBrowserNavigationUrlError as m, isChromeCdpReady as n, stopOpenClawChrome as o, snapshotAria as p, DEFAULT_OPENCLAW_BROWSER_ENABLED as q, isChromeReachable as r, resolveLsofCommandSync as s, getChromeWebSocketUrl as t, createTargetViaCdp as u, appendCdpPath as v, stopChromeExtensionRelayServer as w, getHeadersWithAuth as x, fetchJson as y, isLoopbackHost as z };