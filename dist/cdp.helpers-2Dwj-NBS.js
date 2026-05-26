import { a as redactSensitiveText } from "./redact-R2-EdHUS.js";
import { i as isLoopbackHost } from "./net-Gkm1Cz9b.js";
import { i as hasProxyEnvConfigured } from "./proxy-env-Bl2eQt0u.js";
import { g as resolvePinnedHostnameWithPolicy, t as SsrFBlockedError } from "./ssrf-CYoLqc2K.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-B7xT8hT9.js";
import "./ssrf-runtime-B7YsbRmp.js";
import "./sdk-security-runtime-CMuweZ-u.js";
import { t as BrowserCdpEndpointBlockedError } from "./errors-CI_4JAQw.js";
import WebSocket from "ws";
import http from "node:http";
import https from "node:https";
//#region extensions/browser/src/browser/cdp-proxy-bypass.ts
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
//#region extensions/browser/src/browser/constants.ts
const DEFAULT_OPENCLAW_BROWSER_ENABLED = true;
const DEFAULT_BROWSER_EVALUATE_ENABLED = true;
const DEFAULT_OPENCLAW_BROWSER_COLOR = "#FF4500";
const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = "openclaw";
const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "openclaw";
const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 6e4;
const DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS = 15e3;
const DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS = 8e3;
const DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS = 2e4;
const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 4e4;
const DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS = 8e3;
//#endregion
//#region extensions/browser/src/browser/cdp-timeouts.ts
const CDP_HTTP_REQUEST_TIMEOUT_MS = 1500;
const CDP_WS_HANDSHAKE_TIMEOUT_MS = 5e3;
const CDP_JSON_NEW_TIMEOUT_MS = 1500;
const CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS = 1e4;
const CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS = 5e3;
const CHROME_LAUNCH_READY_WINDOW_MS = DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS;
const CHROME_STOP_TIMEOUT_MS = 2500;
const CHROME_STDERR_HINT_MAX_CHARS = 2e3;
const PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS = 2e3;
const PROFILE_ATTACH_RETRY_TIMEOUT_MS = 1200;
const CHROME_MCP_ATTACH_READY_WINDOW_MS = 8e3;
function usesFastLoopbackCdpProbeClass(params) {
	return params.profileIsLoopback && params.attachOnly !== true;
}
function normalizeTimeoutMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return Math.max(1, Math.floor(value));
}
function resolveCdpReachabilityTimeouts(params) {
	const normalized = normalizeTimeoutMs(params.timeoutMs);
	if (usesFastLoopbackCdpProbeClass({
		profileIsLoopback: params.profileIsLoopback,
		attachOnly: params.attachOnly
	})) {
		const httpTimeoutMs = normalized ?? 300;
		return {
			httpTimeoutMs,
			wsTimeoutMs: Math.max(200, Math.min(PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS, httpTimeoutMs * 2))
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
//#region extensions/browser/src/browser/rate-limit-message.ts
const BROWSER_SERVICE_RATE_LIMIT_MESSAGE = "Browser service rate limit reached. Wait for the current session to complete, or retry later.";
const BROWSERBASE_RATE_LIMIT_MESSAGE = "Browserbase rate limit reached (max concurrent sessions). Wait for the current session to complete, or upgrade your plan.";
function isAbsoluteHttp(url) {
	return /^https?:\/\//i.test(url.trim());
}
function isBrowserbaseUrl(url) {
	if (!isAbsoluteHttp(url)) return false;
	try {
		const host = new URL(url).hostname.trim().toLowerCase();
		return host === "browserbase.com" || host.endsWith(".browserbase.com");
	} catch {
		return false;
	}
}
function resolveBrowserRateLimitMessage(url) {
	return isBrowserbaseUrl(url) ? BROWSERBASE_RATE_LIMIT_MESSAGE : BROWSER_SERVICE_RATE_LIMIT_MESSAGE;
}
//#endregion
//#region extensions/browser/src/browser/ssrf-policy-helpers.ts
function withAllowedHostname(ssrfPolicy, hostname) {
	return {
		...ssrfPolicy,
		allowedHostnames: Array.from(new Set([...ssrfPolicy?.allowedHostnames ?? [], hostname]))
	};
}
//#endregion
//#region extensions/browser/src/browser/cdp.helpers.ts
function parseBrowserHttpUrl(raw, label) {
	const trimmed = raw.trim();
	const parsed = new URL(trimmed);
	if (![
		"http:",
		"https:",
		"ws:",
		"wss:"
	].includes(parsed.protocol)) throw new Error(`${label} must be http(s) or ws(s), got: ${parsed.protocol.replace(":", "")}`);
	const isSecure = parsed.protocol === "https:" || parsed.protocol === "wss:";
	const port = parsed.port && Number.parseInt(parsed.port, 10) > 0 ? Number.parseInt(parsed.port, 10) : isSecure ? 443 : 80;
	/* c8 ignore next 3 */
	if (Number.isNaN(port) || port <= 0 || port > 65535) throw new Error(`${label} has invalid port: ${parsed.port}`);
	return {
		parsed,
		port,
		normalized: parsed.toString().replace(/\/$/, "")
	};
}
/**
* Returns true when the URL uses a WebSocket protocol (ws: or wss:).
* Used to distinguish direct-WebSocket CDP endpoints
* from HTTP(S) endpoints that require /json/version discovery.
*/
function isWebSocketUrl(url) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "ws:" || parsed.protocol === "wss:";
	} catch {
		return false;
	}
}
/**
* Returns true when `url` is a ws/wss URL with a `/devtools/<kind>/<id>`
* path segment — i.e. a handshake-ready per-browser or per-target CDP
* endpoint that can be opened directly without HTTP discovery.
*
* Bare ws roots (`ws://host:port`, `ws://host:port/`) and any other
* non-`/devtools/...` paths are NOT direct endpoints: Chrome's debug
* port only accepts WebSocket upgrades on the specific path returned
* by `GET /json/version`. Callers with a bare ws root must normalise
* it to http for discovery instead of attempting a root handshake that
* Chrome will reject with HTTP 400.
*/
function isDirectCdpWebSocketEndpoint(url) {
	if (!isWebSocketUrl(url)) return false;
	try {
		const parsed = new URL(url);
		return /\/devtools\/(?:browser|page|worker|shared_worker|service_worker)\/[^/]/i.test(parsed.pathname);
	} catch {
		return false;
	}
	/* c8 ignore stop */
}
async function assertCdpEndpointAllowed(cdpUrl, ssrfPolicy) {
	if (!ssrfPolicy) return;
	const parsed = new URL(cdpUrl);
	if (![
		"http:",
		"https:",
		"ws:",
		"wss:"
	].includes(parsed.protocol)) throw new Error(`Invalid CDP URL protocol: ${parsed.protocol.replace(":", "")}`);
	try {
		const policy = isLoopbackHost(parsed.hostname) ? withAllowedHostname(ssrfPolicy, parsed.hostname) : ssrfPolicy;
		await resolvePinnedHostnameWithPolicy(parsed.hostname, { policy });
	} catch (error) {
		throw new BrowserCdpEndpointBlockedError({ cause: error });
	}
}
function redactCdpUrl(cdpUrl) {
	if (typeof cdpUrl !== "string") return cdpUrl;
	const trimmed = cdpUrl.trim();
	if (!trimmed) return trimmed;
	try {
		const parsed = new URL(trimmed);
		parsed.username = "";
		parsed.password = "";
		return redactSensitiveText(parsed.toString().replace(/\/$/, ""));
	} catch {
		return redactSensitiveText(trimmed);
	}
}
function rawCdpMessageToString(data) {
	if (typeof data === "string") return data;
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
	return Buffer.from(data).toString("utf8");
}
function getHeadersWithAuth(url, headers = {}) {
	const mergedHeaders = { ...headers };
	try {
		const parsed = new URL(url);
		if (Object.keys(mergedHeaders).some((key) => key.trim().toLowerCase() === "authorization")) return mergedHeaders;
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
function normalizeCdpHttpBaseForJsonEndpoints(cdpUrl) {
	try {
		const url = new URL(cdpUrl);
		if (url.protocol === "ws:") url.protocol = "http:";
		else if (url.protocol === "wss:") url.protocol = "https:";
		url.pathname = url.pathname.replace(/\/devtools\/browser\/.*$/, "");
		url.pathname = url.pathname.replace(/\/cdp$/, "");
		return url.toString().replace(/\/$/, "");
	} catch {
		return cdpUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/devtools\/browser\/.*$/, "").replace(/\/cdp$/, "").replace(/\/$/, "");
	}
}
function createCdpSender(ws, opts) {
	let nextId = 1;
	const pending = /* @__PURE__ */ new Map();
	const commandTimeoutMs = typeof opts?.commandTimeoutMs === "number" && Number.isFinite(opts.commandTimeoutMs) ? Math.max(1, Math.floor(opts.commandTimeoutMs)) : void 0;
	const clearPendingTimer = (p) => {
		if (p.timer !== void 0) clearTimeout(p.timer);
	};
	const send = (method, params, sessionId) => {
		const id = nextId++;
		const msg = {
			id,
			method,
			params,
			sessionId
		};
		return new Promise((resolve, reject) => {
			if (ws.readyState !== WebSocket.OPEN) {
				reject(/* @__PURE__ */ new Error("CDP socket closed"));
				return;
			}
			const entry = {
				resolve,
				reject
			};
			if (commandTimeoutMs !== void 0) entry.timer = setTimeout(() => {
				closeWithError(/* @__PURE__ */ new Error(`CDP command ${method} timed out after ${commandTimeoutMs}ms`));
			}, commandTimeoutMs);
			pending.set(id, entry);
			try {
				ws.send(JSON.stringify(msg));
			} catch (err) {
				pending.delete(id);
				clearPendingTimer(entry);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	};
	const closeWithError = (err) => {
		for (const [, p] of pending) {
			clearPendingTimer(p);
			p.reject(err);
		}
		pending.clear();
		try {
			ws.close();
		} catch {}
	};
	ws.on("error", (err) => {
		/* c8 ignore next */
		closeWithError(err instanceof Error ? err : new Error(String(err)));
	});
	ws.on("message", (data) => {
		try {
			const parsed = JSON.parse(rawCdpMessageToString(data));
			if (typeof parsed.id !== "number") return;
			const p = pending.get(parsed.id);
			if (!p) return;
			pending.delete(parsed.id);
			clearPendingTimer(p);
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
async function fetchJson(url, timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS, init, ssrfPolicy) {
	const { response, release } = await fetchCdpChecked(url, timeoutMs, init, ssrfPolicy);
	try {
		return await response.json();
	} finally {
		await release();
	}
}
async function fetchCdpChecked(url, timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS, init, ssrfPolicy) {
	const ctrl = new AbortController();
	const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
	let guardedRelease;
	let released = false;
	const release = async () => {
		if (released) return;
		released = true;
		clearTimeout(t);
		await guardedRelease?.();
	};
	try {
		const headers = getHeadersWithAuth(url, init?.headers || {});
		const res = await withNoProxyForCdpUrl(url, async () => {
			const parsedUrl = new URL(url);
			const policy = isLoopbackHost(parsedUrl.hostname) ? withAllowedHostname(ssrfPolicy, parsedUrl.hostname) : ssrfPolicy ?? { allowPrivateNetwork: true };
			const guarded = await fetchWithSsrFGuard({
				url,
				init: {
					...init,
					headers
				},
				signal: ctrl.signal,
				policy,
				auditContext: "browser-cdp"
			});
			guardedRelease = guarded.release;
			return guarded.response;
		});
		if (!res.ok) {
			if (res.status === 429) throw new Error(`${resolveBrowserRateLimitMessage(url)} Do NOT retry the browser tool.`);
			throw new Error(`HTTP ${res.status}`);
		}
		return {
			response: res,
			release
		};
	} catch (error) {
		await release();
		if (error instanceof SsrFBlockedError) throw new BrowserCdpEndpointBlockedError({ cause: error });
		throw error;
	}
}
async function fetchOk(url, timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS, init, ssrfPolicy) {
	const { release } = await fetchCdpChecked(url, timeoutMs, init, ssrfPolicy);
	await release();
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
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function normalizeRetryCount(value, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}
function computeHandshakeRetryDelayMs(attempt, opts) {
	const baseDelayMs = typeof opts?.handshakeRetryDelayMs === "number" && Number.isFinite(opts.handshakeRetryDelayMs) ? Math.max(1, Math.floor(opts.handshakeRetryDelayMs)) : 200;
	const maxDelayMs = typeof opts?.handshakeMaxRetryDelayMs === "number" && Number.isFinite(opts.handshakeMaxRetryDelayMs) ? Math.max(baseDelayMs, Math.floor(opts.handshakeMaxRetryDelayMs)) : 3e3;
	const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
	const jitterScale = .8 + Math.random() * .4;
	return Math.max(1, Math.floor(raw * jitterScale));
}
function shouldRetryCdpHandshakeError(err) {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	if (!msg) return false;
	if (msg.includes("rate limit")) return false;
	const statusMatch = msg.match(/(?:unexpected server response|response):\s*(\d{3})/);
	if (statusMatch?.[1]) return Number(statusMatch[1]) >= 500;
	return msg.includes("cdp socket closed") || msg.includes("econnreset") || msg.includes("econnrefused") || msg.includes("econnaborted") || msg.includes("ehostunreach") || msg.includes("enetunreach") || msg.includes("etimedout") || msg.includes("socket hang up") || msg.includes("websocket error") || msg.includes("closed before");
}
async function withCdpSocket(wsUrl, fn, opts) {
	const maxHandshakeRetries = normalizeRetryCount(opts?.handshakeRetries, 2);
	let lastHandshakeError;
	for (let attempt = 0; attempt <= maxHandshakeRetries; attempt += 1) {
		const ws = openCdpWebSocket(wsUrl, opts);
		const { send, closeWithError } = createCdpSender(ws, opts);
		const openPromise = new Promise((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", (err) => reject(err));
			ws.once("close", () => reject(/* @__PURE__ */ new Error("CDP socket closed")));
		});
		try {
			await openPromise;
		} catch (err) {
			lastHandshakeError = err;
			/* c8 ignore next */
			closeWithError(err instanceof Error ? err : new Error(String(err)));
			try {
				ws.close();
			} catch {}
			if (attempt >= maxHandshakeRetries || !shouldRetryCdpHandshakeError(err)) throw err;
			await sleep(computeHandshakeRetryDelayMs(attempt + 1, opts));
			continue;
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
	if (lastHandshakeError instanceof Error) throw lastHandshakeError;
	throw new Error("CDP socket failed to open");
}
//#endregion
export { DEFAULT_BROWSER_EVALUATE_ENABLED as A, PROFILE_ATTACH_RETRY_TIMEOUT_MS as C, DEFAULT_AI_SNAPSHOT_MAX_CHARS as D, DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS as E, DEFAULT_OPENCLAW_BROWSER_ENABLED as F, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME as I, withNoProxyForCdpUrl as L, DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS as M, DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS as N, DEFAULT_BROWSER_ACTION_TIMEOUT_MS as O, DEFAULT_OPENCLAW_BROWSER_COLOR as P, CHROME_STOP_TIMEOUT_MS as S, usesFastLoopbackCdpProbeClass as T, CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS as _, fetchOk as a, CHROME_MCP_ATTACH_READY_WINDOW_MS as b, isWebSocketUrl as c, parseBrowserHttpUrl as d, redactCdpUrl as f, CDP_JSON_NEW_TIMEOUT_MS as g, resolveBrowserRateLimitMessage as h, fetchJson as i, DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS as j, DEFAULT_BROWSER_DEFAULT_PROFILE_NAME as k, normalizeCdpHttpBaseForJsonEndpoints as l, withAllowedHostname as m, assertCdpEndpointAllowed as n, getHeadersWithAuth as o, withCdpSocket as p, fetchCdpChecked as r, isDirectCdpWebSocketEndpoint as s, appendCdpPath as t, openCdpWebSocket as u, CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS as v, resolveCdpReachabilityTimeouts as w, CHROME_STDERR_HINT_MAX_CHARS as x, CHROME_LAUNCH_READY_WINDOW_MS as y };
