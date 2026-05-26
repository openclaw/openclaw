import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { i as isLoopbackHost } from "./net-DCUMtgJy.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./sdk-security-runtime-C8OhDycR.js";
import { n as getBridgeAuthForPort } from "./bridge-auth-registry-Dh7lGqUM.js";
import { h as resolveBrowserRateLimitMessage } from "./cdp.helpers-D-78hr0t.js";
import { i as resolveProfile, n as resolveBrowserConfig } from "./config-F211Ihcd.js";
import "./config-CblF4FCf.js";
import { n as resolveBrowserControlAuth } from "./control-auth-npUTQ4zl.js";
import "./sdk-setup-tools-C1n7gEuG.js";
//#region extensions/browser/src/browser/client-actions-url.ts
function buildProfileQuery(profile) {
	return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}
function withBaseUrl(baseUrl, path) {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return path;
	return `${trimmed.replace(/\/$/, "")}${path}`;
}
//#endregion
//#region extensions/browser/src/browser/client-fetch.ts
var BrowserServiceError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "BrowserServiceError";
	}
};
function isAbsoluteHttp(url) {
	return /^https?:\/\//i.test(url.trim());
}
function isLoopbackHttpUrl(url) {
	try {
		return isLoopbackHost(new URL(url).hostname);
	} catch {
		return false;
	}
}
function withLoopbackBrowserAuthImpl(url, init, deps) {
	const headers = new Headers(init?.headers ?? {});
	if (headers.has("authorization") || headers.has("x-openclaw-password")) return {
		...init,
		headers
	};
	if (!isLoopbackHttpUrl(url)) return {
		...init,
		headers
	};
	try {
		const cfg = deps.getRuntimeConfig();
		const auth = deps.resolveBrowserControlAuth(cfg);
		if (auth.token) {
			headers.set("Authorization", `Bearer ${auth.token}`);
			return {
				...init,
				headers
			};
		}
		if (auth.password) {
			headers.set("x-openclaw-password", auth.password);
			return {
				...init,
				headers
			};
		}
	} catch {}
	try {
		const parsed = new URL(url);
		const port = parsed.port && Number.parseInt(parsed.port, 10) > 0 ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
		const bridgeAuth = deps.getBridgeAuthForPort(port);
		if (bridgeAuth?.token) headers.set("Authorization", `Bearer ${bridgeAuth.token}`);
		else if (bridgeAuth?.password) headers.set("x-openclaw-password", bridgeAuth.password);
	} catch {}
	return {
		...init,
		headers
	};
}
function withLoopbackBrowserAuth(url, init) {
	return withLoopbackBrowserAuthImpl(url, init, {
		getRuntimeConfig,
		resolveBrowserControlAuth,
		getBridgeAuthForPort
	});
}
const BROWSER_TOOL_MODEL_HINT = "Do NOT retry the browser tool — it will keep failing. Use an alternative approach or inform the user that the browser is currently unavailable.";
function isRateLimitStatus(status) {
	return status === 429;
}
function resolveDispatcherBrowserControlOwnership(url) {
	if (isAbsoluteHttp(url)) return "unknown";
	try {
		const cfg = getRuntimeConfig();
		const resolved = resolveBrowserConfig(cfg?.browser, cfg);
		const requestedProfile = new URL(url, "http://localhost").searchParams.get("profile")?.trim();
		const profile = resolveProfile(resolved, requestedProfile || resolved.defaultProfile);
		if (!profile) return "unknown";
		return profile.driver === "openclaw" && profile.cdpIsLoopback && !profile.attachOnly ? "local-managed" : "external-browser";
	} catch {
		return "unknown";
	}
}
function resolveBrowserFetchOperatorHint(url, opts) {
	if (opts?.ownership === "external-browser") return "The browser profile is external to OpenClaw; make sure its browser/CDP endpoint is running and reachable. Restarting the OpenClaw gateway will not launch it.";
	return !isAbsoluteHttp(url) ? `Restart the OpenClaw gateway (OpenClaw.app menubar, or \`${formatCliCommand("openclaw gateway")}\`).` : "If this is a sandboxed session, ensure the sandbox browser is running.";
}
function normalizeErrorMessage(err) {
	const message = err instanceof Error ? normalizeOptionalString(err.message) : void 0;
	if (message) return message;
	return String(err);
}
function appendBrowserToolModelHint(message) {
	if (message.includes(BROWSER_TOOL_MODEL_HINT)) return message;
	return `${message} ${BROWSER_TOOL_MODEL_HINT}`;
}
function classifyBrowserFetchFailure(err) {
	const msgLower = normalizeLowercaseStringOrEmpty(normalizeErrorMessage(err));
	const nameLower = err instanceof Error ? normalizeLowercaseStringOrEmpty(err.name) : "";
	if (nameLower.includes("timeout") || msgLower.includes("timed out") || msgLower.includes("timeout")) return "timeout";
	return nameLower === "aborterror" || msgLower.includes("aborterror") || msgLower.includes("aborted") || msgLower.includes("abort") || msgLower.includes("cancelled") || msgLower.includes("canceled") ? "aborted" : "persistent";
}
async function discardResponseBody(res) {
	try {
		await res.body?.cancel();
	} catch {}
}
function enhanceDispatcherPathError(url, err) {
	const msg = normalizeErrorMessage(err);
	const kind = classifyBrowserFetchFailure(err);
	const operatorHint = resolveBrowserFetchOperatorHint(url, { ownership: resolveDispatcherBrowserControlOwnership(url) });
	const suffix = kind === "persistent" ? `${operatorHint} ${BROWSER_TOOL_MODEL_HINT}` : operatorHint;
	const normalized = msg.endsWith(".") ? msg : `${msg}.`;
	return new Error(`${normalized} ${suffix}`, err instanceof Error ? { cause: err } : void 0);
}
function enhanceBrowserFetchError(url, err, timeoutMs) {
	const operatorHint = resolveBrowserFetchOperatorHint(url);
	const msg = normalizeErrorMessage(err);
	const kind = classifyBrowserFetchFailure(err);
	if (kind === "timeout") return new Error(`Can't reach the OpenClaw browser control service (timed out after ${timeoutMs}ms). ${operatorHint}`, err instanceof Error ? { cause: err } : void 0);
	if (kind === "aborted") return new Error(`Browser control request was cancelled. ${operatorHint}`, err instanceof Error ? { cause: err } : void 0);
	return new Error(appendBrowserToolModelHint(`Can't reach the OpenClaw browser control service. ${operatorHint} (${msg})`), err instanceof Error ? { cause: err } : void 0);
}
async function fetchHttpJson(url, init) {
	const timeoutMs = init.timeoutMs ?? 5e3;
	const ctrl = new AbortController();
	const upstreamSignal = init.signal;
	let upstreamAbortListener;
	if (upstreamSignal) if (upstreamSignal.aborted) ctrl.abort(upstreamSignal.reason);
	else {
		upstreamAbortListener = () => ctrl.abort(upstreamSignal.reason);
		upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
	}
	const t = setTimeout(() => ctrl.abort(/* @__PURE__ */ new Error("timed out")), timeoutMs);
	let release;
	try {
		const guarded = await fetchWithSsrFGuard({
			url,
			init,
			signal: ctrl.signal,
			policy: { allowPrivateNetwork: true },
			auditContext: "browser-control-client"
		});
		release = guarded.release;
		const res = guarded.response;
		if (!res.ok) {
			if (isRateLimitStatus(res.status)) {
				await discardResponseBody(res);
				throw new BrowserServiceError(`${resolveBrowserRateLimitMessage(url)} ${BROWSER_TOOL_MODEL_HINT}`);
			}
			throw new BrowserServiceError(await res.text().catch(() => "") || `HTTP ${res.status}`);
		}
		return await res.json();
	} finally {
		clearTimeout(t);
		await release?.();
		if (upstreamSignal && upstreamAbortListener) upstreamSignal.removeEventListener("abort", upstreamAbortListener);
	}
}
async function fetchBrowserJson(url, init) {
	const timeoutMs = init?.timeoutMs ?? 5e3;
	let isDispatcherPath = false;
	try {
		if (isAbsoluteHttp(url)) return await fetchHttpJson(url, {
			...withLoopbackBrowserAuth(url, init),
			timeoutMs
		});
		isDispatcherPath = true;
		const { dispatchBrowserControlRequest } = await import("./local-dispatch.runtime.js");
		const parsed = new URL(url, "http://localhost");
		const query = {};
		for (const [key, value] of parsed.searchParams.entries()) query[key] = value;
		let body = init?.body;
		if (typeof body === "string") try {
			body = JSON.parse(body);
		} catch {}
		const abortCtrl = new AbortController();
		const upstreamSignal = init?.signal;
		let upstreamAbortListener;
		if (upstreamSignal) if (upstreamSignal.aborted) abortCtrl.abort(upstreamSignal.reason);
		else {
			upstreamAbortListener = () => abortCtrl.abort(upstreamSignal.reason);
			upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
		}
		let abortListener;
		const abortPromise = abortCtrl.signal.aborted ? Promise.reject(abortCtrl.signal.reason ?? /* @__PURE__ */ new Error("aborted")) : new Promise((_, reject) => {
			abortListener = () => reject(abortCtrl.signal.reason ?? /* @__PURE__ */ new Error("aborted"));
			abortCtrl.signal.addEventListener("abort", abortListener, { once: true });
		});
		let timer;
		if (timeoutMs) timer = setTimeout(() => abortCtrl.abort(/* @__PURE__ */ new Error("timed out")), timeoutMs);
		const dispatchPromise = dispatchBrowserControlRequest({
			method: init?.method?.toUpperCase() === "DELETE" ? "DELETE" : init?.method?.toUpperCase() === "POST" ? "POST" : "GET",
			path: parsed.pathname,
			query,
			body,
			signal: abortCtrl.signal
		});
		const result = await Promise.race([dispatchPromise, abortPromise]).finally(() => {
			if (timer) clearTimeout(timer);
			if (abortListener) abortCtrl.signal.removeEventListener("abort", abortListener);
			if (upstreamSignal && upstreamAbortListener) upstreamSignal.removeEventListener("abort", upstreamAbortListener);
		});
		if (result.status >= 400) {
			if (isRateLimitStatus(result.status)) throw new BrowserServiceError(`${resolveBrowserRateLimitMessage(url)} ${BROWSER_TOOL_MODEL_HINT}`);
			throw new BrowserServiceError(result.body && typeof result.body === "object" && "error" in result.body ? String(result.body.error) : `HTTP ${result.status}`);
		}
		return result.body;
	} catch (err) {
		if (err instanceof BrowserServiceError) throw err;
		if (isDispatcherPath) throw enhanceDispatcherPathError(url, err);
		throw enhanceBrowserFetchError(url, err, timeoutMs);
	}
}
//#endregion
//#region extensions/browser/src/browser/client.ts
const BROWSER_STATUS_REQUEST_TIMEOUT_MS = 7500;
const BROWSER_DOCTOR_REQUEST_TIMEOUT_MS = 7500;
const BROWSER_DEEP_DOCTOR_REQUEST_TIMEOUT_MS = 1e4;
async function browserStatus(baseUrl, opts) {
	return await fetchBrowserJson(withBaseUrl(baseUrl, `/${buildProfileQuery(opts?.profile)}`), { timeoutMs: typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : BROWSER_STATUS_REQUEST_TIMEOUT_MS });
}
async function browserDoctor(baseUrl, opts) {
	const params = new URLSearchParams();
	if (opts?.profile) params.set("profile", opts.profile);
	if (opts?.deep) params.set("deep", "true");
	return await fetchBrowserJson(withBaseUrl(baseUrl, `/doctor${params.size ? `?${params.toString()}` : ""}`), { timeoutMs: opts?.deep ? BROWSER_DEEP_DOCTOR_REQUEST_TIMEOUT_MS : BROWSER_DOCTOR_REQUEST_TIMEOUT_MS });
}
async function browserProfiles(baseUrl, opts) {
	return (await fetchBrowserJson(withBaseUrl(baseUrl, `/profiles`), { timeoutMs: typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e3 })).profiles ?? [];
}
async function browserStart(baseUrl, opts) {
	await fetchBrowserJson(withBaseUrl(baseUrl, `/start${buildProfileQuery(opts?.profile)}`), {
		method: "POST",
		timeoutMs: typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 15e3
	});
}
async function browserStop(baseUrl, opts) {
	await fetchBrowserJson(withBaseUrl(baseUrl, `/stop${buildProfileQuery(opts?.profile)}`), {
		method: "POST",
		timeoutMs: typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 15e3
	});
}
async function browserResetProfile(baseUrl, opts) {
	return await fetchBrowserJson(withBaseUrl(baseUrl, `/reset-profile${buildProfileQuery(opts?.profile)}`), {
		method: "POST",
		timeoutMs: 2e4
	});
}
async function browserCreateProfile(baseUrl, opts) {
	return await fetchBrowserJson(withBaseUrl(baseUrl, `/profiles/create`), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: opts.name,
			color: opts.color,
			cdpUrl: opts.cdpUrl,
			userDataDir: opts.userDataDir,
			driver: opts.driver
		}),
		timeoutMs: 1e4
	});
}
async function browserDeleteProfile(baseUrl, profile) {
	return await fetchBrowserJson(withBaseUrl(baseUrl, `/profiles/${encodeURIComponent(profile)}`), {
		method: "DELETE",
		timeoutMs: 2e4
	});
}
async function browserTabs(baseUrl, opts) {
	return (await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs${buildProfileQuery(opts?.profile)}`), { timeoutMs: typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e3 })).tabs ?? [];
}
async function browserOpenTab(baseUrl, url, opts) {
	return await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/open${buildProfileQuery(opts?.profile)}`), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			url,
			...opts?.label ? { label: opts.label } : {}
		}),
		timeoutMs: typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 15e3
	});
}
async function browserFocusTab(baseUrl, targetId, opts) {
	await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/focus${buildProfileQuery(opts?.profile)}`), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ targetId }),
		timeoutMs: typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 5e3
	});
}
async function browserCloseTab(baseUrl, targetId, opts) {
	const q = buildProfileQuery(opts?.profile);
	await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/${encodeURIComponent(targetId)}${q}`), {
		method: "DELETE",
		timeoutMs: typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 5e3
	});
}
async function browserTabAction(baseUrl, opts) {
	return await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/action${buildProfileQuery(opts.profile)}`), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			action: opts.action,
			index: opts.index
		}),
		timeoutMs: 1e4
	});
}
async function browserSnapshot(baseUrl, opts) {
	const q = new URLSearchParams();
	if (opts.format) q.set("format", opts.format);
	if (opts.targetId) q.set("targetId", opts.targetId);
	if (typeof opts.limit === "number") q.set("limit", String(opts.limit));
	if (typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars)) q.set("maxChars", String(opts.maxChars));
	if (opts.refs === "aria" || opts.refs === "role") q.set("refs", opts.refs);
	if (typeof opts.interactive === "boolean") q.set("interactive", String(opts.interactive));
	if (typeof opts.compact === "boolean") q.set("compact", String(opts.compact));
	if (typeof opts.depth === "number" && Number.isFinite(opts.depth)) q.set("depth", String(opts.depth));
	if (opts.selector?.trim()) q.set("selector", opts.selector.trim());
	if (opts.frame?.trim()) q.set("frame", opts.frame.trim());
	if (opts.labels === true) q.set("labels", "1");
	if (opts.urls === true) q.set("urls", "1");
	if (opts.mode) q.set("mode", opts.mode);
	if (opts.profile) q.set("profile", opts.profile);
	return await fetchBrowserJson(withBaseUrl(baseUrl, `/snapshot?${q.toString()}`), { timeoutMs: 2e4 });
}
//#endregion
//#region extensions/browser/src/browser/session-tab-registry.ts
const trackedTabsBySession = /* @__PURE__ */ new Map();
function normalizeSessionKey(raw) {
	return normalizeOptionalLowercaseString(raw) ?? "";
}
function normalizeTargetId(raw) {
	return raw.trim();
}
function normalizeProfile(raw) {
	return normalizeOptionalLowercaseString(raw);
}
function normalizeBaseUrl(raw) {
	if (!raw) return;
	const trimmed = raw.trim();
	return trimmed ? trimmed : void 0;
}
function toTrackedTabId(params) {
	return `${params.targetId}\u0000${params.baseUrl ?? ""}\u0000${params.profile ?? ""}`;
}
function resolveTrackedTabIdentity(params) {
	const sessionKeyRaw = params.sessionKey?.trim();
	const targetIdRaw = params.targetId?.trim();
	if (!sessionKeyRaw || !targetIdRaw) return;
	return {
		sessionKey: normalizeSessionKey(sessionKeyRaw),
		targetId: normalizeTargetId(targetIdRaw),
		baseUrl: normalizeBaseUrl(params.baseUrl),
		profile: normalizeProfile(params.profile)
	};
}
function isIgnorableCloseError(err) {
	const message = normalizeLowercaseStringOrEmpty(String(err));
	return message.includes("tab not found") || message.includes("target closed") || message.includes("target not found") || message.includes("no such target");
}
function trackSessionBrowserTab(params) {
	const identity = resolveTrackedTabIdentity(params);
	if (!identity) return;
	const now = Date.now();
	const tracked = {
		...identity,
		trackedAt: now,
		lastUsedAt: now
	};
	const trackedId = toTrackedTabId(tracked);
	let trackedForSession = trackedTabsBySession.get(identity.sessionKey);
	if (!trackedForSession) {
		trackedForSession = /* @__PURE__ */ new Map();
		trackedTabsBySession.set(identity.sessionKey, trackedForSession);
	}
	const existing = trackedForSession.get(trackedId);
	trackedForSession.set(trackedId, {
		...tracked,
		trackedAt: existing?.trackedAt ?? tracked.trackedAt
	});
}
function touchSessionBrowserTab(params) {
	const identity = resolveTrackedTabIdentity(params);
	if (!identity) return;
	const trackedForSession = trackedTabsBySession.get(identity.sessionKey);
	if (!trackedForSession) return;
	const trackedId = toTrackedTabId(identity);
	const tracked = trackedForSession.get(trackedId);
	if (!tracked) return;
	trackedForSession.set(trackedId, {
		...tracked,
		lastUsedAt: params.now ?? Date.now()
	});
}
function untrackSessionBrowserTab(params) {
	const identity = resolveTrackedTabIdentity(params);
	if (!identity) return;
	const trackedForSession = trackedTabsBySession.get(identity.sessionKey);
	if (!trackedForSession) return;
	const trackedId = toTrackedTabId(identity);
	trackedForSession.delete(trackedId);
	if (trackedForSession.size === 0) trackedTabsBySession.delete(identity.sessionKey);
}
function takeTrackedTabsForSessionKeys(sessionKeys) {
	const uniqueSessionKeys = /* @__PURE__ */ new Set();
	for (const key of sessionKeys) {
		if (!key?.trim()) continue;
		uniqueSessionKeys.add(normalizeSessionKey(key));
	}
	if (uniqueSessionKeys.size === 0) return [];
	const seenTrackedIds = /* @__PURE__ */ new Set();
	const tabs = [];
	for (const sessionKey of uniqueSessionKeys) {
		const trackedForSession = trackedTabsBySession.get(sessionKey);
		if (!trackedForSession || trackedForSession.size === 0) continue;
		trackedTabsBySession.delete(sessionKey);
		for (const tracked of trackedForSession.values()) {
			const trackedId = toTrackedTabId(tracked);
			if (seenTrackedIds.has(trackedId)) continue;
			seenTrackedIds.add(trackedId);
			tabs.push(tracked);
		}
	}
	return tabs;
}
async function closeTrackedTabs(params) {
	if (params.tabs.length === 0) return 0;
	const closeTab = params.closeTab ?? (async (tab) => {
		await browserCloseTab(tab.baseUrl, tab.targetId, { profile: tab.profile });
	});
	let closed = 0;
	for (const tab of params.tabs) try {
		await closeTab({
			targetId: tab.targetId,
			baseUrl: tab.baseUrl,
			profile: tab.profile
		});
		closed += 1;
	} catch (err) {
		if (!isIgnorableCloseError(err)) params.onWarn?.(`failed to close tracked browser tab ${tab.targetId}: ${String(err)}`);
	}
	return closed;
}
async function closeTrackedBrowserTabsForSessions(params) {
	return await closeTrackedTabs({
		tabs: takeTrackedTabsForSessionKeys(params.sessionKeys),
		closeTab: params.closeTab,
		onWarn: params.onWarn
	});
}
function takeStaleTrackedTabs(params) {
	const tabsToClose = [];
	const takenIdsBySession = /* @__PURE__ */ new Map();
	const mark = (sessionKey, trackedId, tracked) => {
		let takenForSession = takenIdsBySession.get(sessionKey);
		if (!takenForSession) {
			takenForSession = /* @__PURE__ */ new Set();
			takenIdsBySession.set(sessionKey, takenForSession);
		}
		if (takenForSession.has(trackedId)) return;
		takenForSession.add(trackedId);
		tabsToClose.push(tracked);
	};
	for (const [sessionKey, trackedForSession] of trackedTabsBySession) {
		if (params.sessionFilter && !params.sessionFilter(sessionKey)) continue;
		const entries = [...trackedForSession.entries()].toSorted((a, b) => a[1].lastUsedAt - b[1].lastUsedAt || a[1].trackedAt - b[1].trackedAt);
		if (params.idleMs && params.idleMs > 0) {
			for (const [trackedId, tracked] of entries) if (params.now - tracked.lastUsedAt >= params.idleMs) mark(sessionKey, trackedId, tracked);
		}
		const remainingEntries = entries.filter(([trackedId]) => !takenIdsBySession.get(sessionKey)?.has(trackedId));
		if (params.maxTabsPerSession && params.maxTabsPerSession > 0 && remainingEntries.length > params.maxTabsPerSession) {
			const excess = remainingEntries.length - params.maxTabsPerSession;
			for (const [trackedId, tracked] of remainingEntries.slice(0, excess)) mark(sessionKey, trackedId, tracked);
		}
	}
	for (const [sessionKey, trackedIds] of takenIdsBySession) {
		const trackedForSession = trackedTabsBySession.get(sessionKey);
		if (!trackedForSession) continue;
		for (const trackedId of trackedIds) trackedForSession.delete(trackedId);
		if (trackedForSession.size === 0) trackedTabsBySession.delete(sessionKey);
	}
	return tabsToClose;
}
async function sweepTrackedBrowserTabs(params) {
	return await closeTrackedTabs({
		tabs: takeStaleTrackedTabs({
			now: params.now ?? Date.now(),
			idleMs: params.idleMs,
			maxTabsPerSession: params.maxTabsPerSession,
			sessionFilter: params.sessionFilter
		}),
		closeTab: params.closeTab,
		onWarn: params.onWarn
	});
}
//#endregion
export { withBaseUrl as S, browserStop as _, untrackSessionBrowserTab as a, fetchBrowserJson as b, browserDeleteProfile as c, browserOpenTab as d, browserProfiles as f, browserStatus as g, browserStart as h, trackSessionBrowserTab as i, browserDoctor as l, browserSnapshot as m, sweepTrackedBrowserTabs as n, browserCloseTab as o, browserResetProfile as p, touchSessionBrowserTab as r, browserCreateProfile as s, closeTrackedBrowserTabsForSessions as t, browserFocusTab as u, browserTabAction as v, buildProfileQuery as x, browserTabs as y };
