import { s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import { i as isLoopbackHost } from "./net-DCUMtgJy.js";
import { i as hasProxyEnvConfigured } from "./proxy-env-Cs0G_0hd.js";
import { _ as resolvePinnedHostnameWithPolicy, t as SsrFBlockedError } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./logging-core-DwEC9Ajh.js";
import "./sdk-security-runtime-C8OhDycR.js";
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
function noProxyValueCoversLocalhost(value) {
	const entries = new Set((value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean));
	return entries.has("localhost") && entries.has("127.0.0.1") && entries.has("[::1]");
}
function noProxyAlreadyCoversLocalhost() {
	return noProxyValueCoversLocalhost(process.env.NO_PROXY) && noProxyValueCoversLocalhost(process.env.no_proxy);
}
function appendLoopbackEntries(value) {
	return value ? `${value},${LOOPBACK_ENTRIES}` : LOOPBACK_ENTRIES;
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
			const appliedNoProxy = appendLoopbackEntries(noProxy || noProxyLower);
			const appliedNoProxyLower = appendLoopbackEntries(noProxyLower || noProxy);
			process.env.NO_PROXY = appliedNoProxy;
			process.env.no_proxy = appliedNoProxyLower;
			this.snapshot = {
				noProxy,
				noProxyLower,
				appliedNoProxy,
				appliedNoProxyLower
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
		const { noProxy, noProxyLower, appliedNoProxy, appliedNoProxyLower } = this.snapshot;
		const currentNoProxy = process.env.NO_PROXY;
		const currentNoProxyLower = process.env.no_proxy;
		if (currentNoProxy === appliedNoProxy) if (noProxy !== void 0) process.env.NO_PROXY = noProxy;
		else delete process.env.NO_PROXY;
		if (currentNoProxyLower === appliedNoProxyLower) if (noProxyLower !== void 0) process.env.no_proxy = noProxyLower;
		else delete process.env.no_proxy;
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
//#region extensions/browser/src/browser/errors.ts
const BROWSER_ENDPOINT_BLOCKED_MESSAGE = "browser endpoint blocked by policy";
const BROWSER_NAVIGATION_BLOCKED_MESSAGE = "browser navigation blocked by policy";
var BrowserError = class extends Error {
	constructor(message, status = 500, options) {
		super(message, options);
		this.name = new.target.name;
		this.status = status;
	}
};
/**
* Raised when a browser CDP endpoint (the cdpUrl itself) fails the
* configured SSRF policy. Distinct from a blocked navigation target so
* callers see "fix your browser endpoint config" rather than "fix your
* navigation URL".
*/
var BrowserCdpEndpointBlockedError = class extends BrowserError {
	constructor(options) {
		super(BROWSER_ENDPOINT_BLOCKED_MESSAGE, 400, options);
	}
};
var BrowserValidationError = class extends BrowserError {
	constructor(message, options) {
		super(message, 400, options);
	}
};
var BrowserTargetAmbiguousError = class extends BrowserError {
	constructor(message = "ambiguous target id prefix", options) {
		super(message, 409, options);
	}
};
var BrowserTabNotFoundError = class extends BrowserError {
	constructor(inputOrMessage, options) {
		const input = typeof inputOrMessage === "object" ? inputOrMessage.input?.trim() : inputOrMessage?.trim();
		const message = input ? /^\d+$/.test(input) ? `tab not found: browser tab "${input}" not found. Numeric values are not tab targets; use a stable tab id like "t1", a label, or a raw targetId. For positional selection, use "openclaw browser tab select ${input}".` : `tab not found: browser tab "${input}" not found. Use action=tabs and pass suggestedTargetId, tabId, label, or raw targetId.` : "tab not found";
		super(message, 404, options);
	}
};
var BrowserProfileNotFoundError = class extends BrowserError {
	constructor(message, options) {
		super(message, 404, options);
	}
};
var BrowserConflictError = class extends BrowserError {
	constructor(message, options) {
		super(message, 409, options);
	}
};
var BrowserResetUnsupportedError = class extends BrowserError {
	constructor(message, options) {
		super(message, 400, options);
	}
};
var BrowserProfileUnavailableError = class extends BrowserError {
	constructor(message, options) {
		super(message, 409, options);
	}
};
var BrowserResourceExhaustedError = class extends BrowserError {
	constructor(message, options) {
		super(message, 507, options);
	}
};
function toBrowserErrorResponse(err) {
	if (err instanceof BrowserError) return {
		status: err.status,
		message: err.message
	};
	if (err instanceof Error && err.name === "BlockedBrowserTargetError") return {
		status: 409,
		message: err.message
	};
	if (err instanceof Error && err.name === "SsrFBlockedError") return {
		status: 400,
		message: BROWSER_NAVIGATION_BLOCKED_MESSAGE
	};
	if (err instanceof Error && err.name === "InvalidBrowserNavigationUrlError") return {
		status: 400,
		message: err.message
	};
	return null;
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
/**
* Detects whether a raw URL string contains an explicitly written port.
*
* WHATWG `URL` normalizes default ports (e.g. `:80` for http, `:443` for
* https) to an empty `.port` string, making it impossible to distinguish
* "user wrote :80" from "user omitted the port". This helper inspects the
* raw string to preserve that intent.
*
* Handles IPv6 bracket notation and userinfo (user:pass@host) correctly.
*/
function hasRawExplicitPort(raw) {
	const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/, 1)[0] ?? "";
	const hostPort = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
	if (hostPort.startsWith("[")) return /^\[[^\]]+\]:\d+$/.test(hostPort);
	return /:\d+$/.test(hostPort);
}
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
	const normalized = parsed.toString().replace(/\/$/, "");
	const hasExplicitPort = hasRawExplicitPort(trimmed);
	let normalizedWithPort;
	if (hasExplicitPort && !parsed.port) {
		const proto = parsed.protocol + "//";
		const rest = normalized.slice(proto.length);
		const atIdx = rest.indexOf("@");
		const hostStart = atIdx >= 0 ? atIdx + 1 : 0;
		const hostPart = rest.slice(hostStart);
		const insertAt = hostStart + (hostPart.startsWith("[") ? hostPart.indexOf("]") + 1 : (() => {
			const idx = hostPart.search(/[:/]/);
			return idx < 0 ? hostPart.length : idx;
		})());
		normalizedWithPort = proto + rest.slice(0, insertAt) + ":" + port + rest.slice(insertAt);
	} else normalizedWithPort = normalized;
	return {
		parsed,
		port,
		hasExplicitPort,
		normalized,
		normalizedWithPort
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
function stripUrlCredentials(url) {
	try {
		const parsed = new URL(url);
		if (!parsed.username && !parsed.password) return url;
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return url;
	}
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
		const fetchUrl = stripUrlCredentials(url);
		const res = await withNoProxyForCdpUrl(url, async () => {
			const parsedUrl = new URL(fetchUrl);
			const policy = isLoopbackHost(parsedUrl.hostname) ? withAllowedHostname(ssrfPolicy, parsedUrl.hostname) : ssrfPolicy ?? { allowPrivateNetwork: true };
			const guarded = await fetchWithSsrFGuard({
				url: fetchUrl,
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
export { CHROME_LAUNCH_READY_WINDOW_MS as A, DEFAULT_BROWSER_DEFAULT_PROFILE_NAME as B, BrowserTabNotFoundError as C, CDP_JSON_NEW_TIMEOUT_MS as D, toBrowserErrorResponse as E, resolveCdpReachabilityTimeouts as F, DEFAULT_OPENCLAW_BROWSER_COLOR as G, DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS as H, usesFastLoopbackCdpProbeClass as I, withNoProxyForCdpUrl as J, DEFAULT_OPENCLAW_BROWSER_ENABLED as K, DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS as L, CHROME_STDERR_HINT_MAX_CHARS as M, CHROME_STOP_TIMEOUT_MS as N, CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS as O, PROFILE_ATTACH_RETRY_TIMEOUT_MS as P, DEFAULT_AI_SNAPSHOT_MAX_CHARS as R, BrowserResourceExhaustedError as S, BrowserValidationError as T, DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS as U, DEFAULT_BROWSER_EVALUATE_ENABLED as V, DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS as W, BrowserConflictError as _, fetchOk as a, BrowserProfileUnavailableError as b, isWebSocketUrl as c, parseBrowserHttpUrl as d, redactCdpUrl as f, BrowserCdpEndpointBlockedError as g, resolveBrowserRateLimitMessage as h, fetchJson as i, CHROME_MCP_ATTACH_READY_WINDOW_MS as j, CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS as k, normalizeCdpHttpBaseForJsonEndpoints as l, withAllowedHostname as m, assertCdpEndpointAllowed as n, getHeadersWithAuth as o, withCdpSocket as p, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME as q, fetchCdpChecked as r, isDirectCdpWebSocketEndpoint as s, appendCdpPath as t, openCdpWebSocket as u, BrowserError as v, BrowserTargetAmbiguousError as w, BrowserResetUnsupportedError as x, BrowserProfileNotFoundError as y, DEFAULT_BROWSER_ACTION_TIMEOUT_MS as z };
