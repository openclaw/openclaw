import { s as logWarn } from "./exec-BhaMholX.js";
import { a as resolvePinnedHostnameWithPolicy, n as closeDispatcher, r as createPinnedDispatcher, t as SsrFBlockedError } from "./ssrf-Bte-xH9B.js";
import { t as bindAbortRelay } from "./fetch-timeout-Meg2TxSF.js";
import { EnvHttpProxyAgent } from "undici";

//#region src/infra/net/fetch-guard.ts
const DEFAULT_MAX_REDIRECTS = 3;
const ENV_PROXY_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy"
];
const CROSS_ORIGIN_REDIRECT_SENSITIVE_HEADERS = [
	"authorization",
	"proxy-authorization",
	"cookie",
	"cookie2"
];
function hasEnvProxyConfigured() {
	for (const key of ENV_PROXY_KEYS) {
		const value = process.env[key];
		if (typeof value === "string" && value.trim()) return true;
	}
	return false;
}
function isRedirectStatus(status) {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function stripSensitiveHeadersForCrossOriginRedirect(init) {
	if (!init?.headers) return init;
	const headers = new Headers(init.headers);
	for (const header of CROSS_ORIGIN_REDIRECT_SENSITIVE_HEADERS) headers.delete(header);
	return {
		...init,
		headers
	};
}
function buildAbortSignal(params) {
	const { timeoutMs, signal } = params;
	if (!timeoutMs && !signal) return {
		signal: void 0,
		cleanup: () => {}
	};
	if (!timeoutMs) return {
		signal,
		cleanup: () => {}
	};
	const controller = new AbortController();
	const timeoutId = setTimeout(controller.abort.bind(controller), timeoutMs);
	const onAbort = bindAbortRelay(controller);
	if (signal) if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", onAbort, { once: true });
	const cleanup = () => {
		clearTimeout(timeoutId);
		if (signal) signal.removeEventListener("abort", onAbort);
	};
	return {
		signal: controller.signal,
		cleanup
	};
}
async function fetchWithSsrFGuard(params) {
	const fetcher = params.fetchImpl ?? globalThis.fetch;
	if (!fetcher) throw new Error("fetch is not available");
	const maxRedirects = typeof params.maxRedirects === "number" && Number.isFinite(params.maxRedirects) ? Math.max(0, Math.floor(params.maxRedirects)) : DEFAULT_MAX_REDIRECTS;
	const { signal, cleanup } = buildAbortSignal({
		timeoutMs: params.timeoutMs,
		signal: params.signal
	});
	let released = false;
	const release = async (dispatcher) => {
		if (released) return;
		released = true;
		cleanup();
		await closeDispatcher(dispatcher ?? void 0);
	};
	const visited = /* @__PURE__ */ new Set();
	let currentUrl = params.url;
	let currentInit = params.init ? { ...params.init } : void 0;
	let redirectCount = 0;
	while (true) {
		let parsedUrl;
		try {
			parsedUrl = new URL(currentUrl);
		} catch {
			await release();
			throw new Error("Invalid URL: must be http or https");
		}
		if (!["http:", "https:"].includes(parsedUrl.protocol)) {
			await release();
			throw new Error("Invalid URL: must be http or https");
		}
		let dispatcher = null;
		try {
			const pinned = await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
				lookupFn: params.lookupFn,
				policy: params.policy
			});
			if (params.proxy === "env" && hasEnvProxyConfigured()) dispatcher = new EnvHttpProxyAgent();
			else if (params.pinDns !== false) dispatcher = createPinnedDispatcher(pinned);
			const init = {
				...currentInit ? { ...currentInit } : {},
				redirect: "manual",
				...dispatcher ? { dispatcher } : {},
				...signal ? { signal } : {}
			};
			const response = await fetcher(parsedUrl.toString(), init);
			if (isRedirectStatus(response.status)) {
				const location = response.headers.get("location");
				if (!location) {
					await release(dispatcher);
					throw new Error(`Redirect missing location header (${response.status})`);
				}
				redirectCount += 1;
				if (redirectCount > maxRedirects) {
					await release(dispatcher);
					throw new Error(`Too many redirects (limit: ${maxRedirects})`);
				}
				const nextParsedUrl = new URL(location, parsedUrl);
				const nextUrl = nextParsedUrl.toString();
				if (visited.has(nextUrl)) {
					await release(dispatcher);
					throw new Error("Redirect loop detected");
				}
				if (nextParsedUrl.origin !== parsedUrl.origin) currentInit = stripSensitiveHeadersForCrossOriginRedirect(currentInit);
				visited.add(nextUrl);
				response.body?.cancel();
				await closeDispatcher(dispatcher);
				currentUrl = nextUrl;
				continue;
			}
			return {
				response,
				finalUrl: currentUrl,
				release: async () => release(dispatcher)
			};
		} catch (err) {
			if (err instanceof SsrFBlockedError) logWarn(`security: blocked URL fetch (${params.auditContext ?? "url-fetch"}) target=${parsedUrl.origin}${parsedUrl.pathname} reason=${err.message}`);
			await release(dispatcher);
			throw err;
		}
	}
}

//#endregion
export { fetchWithSsrFGuard as t };