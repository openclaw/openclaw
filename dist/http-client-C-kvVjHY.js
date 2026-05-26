import { _ as resolvePinnedHostnameWithPolicy, a as createPinnedDispatcher, i as closeDispatcher } from "./ssrf-DdDeGa5L.js";
import { n as buildTimeoutAbortSignal } from "./fetch-timeout-CptH2le9.js";
import { n as fetchWithRuntimeDispatcherOrMockedGlobal } from "./runtime-fetch-BCUOAbGl.js";
import { n as readResponseWithLimit$1 } from "./read-response-with-limit-S6PVjcFB.js";
import "./runtime-fetch-rT3QHXVF.js";
import "./ssrf-dispatcher-2_i6w23b.js";
import "./timeout-abort-signal-BzCRuO5K.js";
//#region extensions/matrix/src/matrix/sdk/event-helpers.ts
function matrixEventToRaw(event, opts = {}) {
	const unsigned = event.getUnsigned?.() ?? {};
	const eventWithOriginalContent = event;
	const content = opts.contentMode === "original" ? eventWithOriginalContent.getOriginalContent?.() ?? event.getContent?.() ?? {} : event.getContent?.() ?? eventWithOriginalContent.getOriginalContent?.() ?? {};
	const raw = {
		event_id: event.getId() ?? "",
		sender: event.getSender() ?? "",
		type: event.getType() ?? "",
		origin_server_ts: event.getTs() ?? 0,
		content: content || {},
		unsigned
	};
	const stateKey = resolveMatrixStateKey(event);
	if (typeof stateKey === "string") raw.state_key = stateKey;
	return raw;
}
function parseMxc(url) {
	const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(url.trim());
	if (!match) return null;
	return {
		server: match[1],
		mediaId: match[2]
	};
}
function buildHttpError(statusCode, bodyText) {
	let message = `Matrix HTTP ${statusCode}`;
	if (bodyText.trim()) try {
		const parsed = JSON.parse(bodyText);
		if (typeof parsed.error === "string" && parsed.error.trim()) message = parsed.error.trim();
		else message = bodyText.slice(0, 500);
	} catch {
		message = bodyText.slice(0, 500);
	}
	return Object.assign(new Error(message), { statusCode });
}
function resolveMatrixStateKey(event) {
	const direct = event.getStateKey?.();
	if (typeof direct === "string") return direct;
	const wireContent = event.getWireContent?.();
	if (wireContent && typeof wireContent.state_key === "string") return wireContent.state_key;
	const rawEvent = event.event;
	if (rawEvent && typeof rawEvent.state_key === "string") return rawEvent.state_key;
}
//#endregion
//#region extensions/matrix/src/matrix/media-errors.ts
const MATRIX_MEDIA_SIZE_LIMIT_ERROR_MESSAGE = "Matrix media exceeds configured size limit";
var MatrixMediaSizeLimitError = class extends Error {
	constructor(message = MATRIX_MEDIA_SIZE_LIMIT_ERROR_MESSAGE, options) {
		super(message, options);
		this.code = "MATRIX_MEDIA_SIZE_LIMIT";
		this.name = "MatrixMediaSizeLimitError";
	}
};
function isMatrixMediaSizeLimitError(err) {
	if (err instanceof MatrixMediaSizeLimitError) return true;
	if (!(err instanceof Error) || err.cause === void 0) return false;
	return isMatrixMediaSizeLimitError(err.cause);
}
//#endregion
//#region extensions/matrix/src/matrix/sdk/read-response-with-limit.ts
async function readResponseWithLimit(res, maxBytes, opts) {
	return await readResponseWithLimit$1(res, maxBytes, {
		...opts,
		onIdleTimeout: opts?.onIdleTimeout ?? (({ chunkTimeoutMs }) => /* @__PURE__ */ new Error(`Matrix media download stalled: no data received for ${chunkTimeoutMs}ms`))
	});
}
//#endregion
//#region extensions/matrix/src/matrix/sdk/transport.ts
function normalizeEndpoint(endpoint) {
	if (!endpoint) return "/";
	return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
}
function applyQuery(url, qs) {
	if (!qs) return;
	for (const [key, rawValue] of Object.entries(qs)) {
		if (rawValue === void 0 || rawValue === null) continue;
		if (Array.isArray(rawValue)) {
			for (const item of rawValue) {
				if (item === void 0 || item === null) continue;
				url.searchParams.append(key, String(item));
			}
			continue;
		}
		url.searchParams.set(key, String(rawValue));
	}
}
function isRedirectStatus(statusCode) {
	return statusCode >= 300 && statusCode < 400;
}
function toFetchUrl(resource) {
	if (resource instanceof URL) return resource.toString();
	if (typeof resource === "string") return resource;
	return resource.url;
}
const MATRIX_STATE_AFTER_SYNC_PARAM = "org.matrix.msc4222.use_state_after";
function withoutMatrixStateAfterSyncParam(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return rawUrl;
	}
	if (!url.pathname.endsWith("/sync") || !url.searchParams.has(MATRIX_STATE_AFTER_SYNC_PARAM)) return rawUrl;
	url.searchParams.delete(MATRIX_STATE_AFTER_SYNC_PARAM);
	return url.toString();
}
function buildBufferedResponse(params) {
	const response = new Response(params.body, {
		status: params.source.status,
		statusText: params.source.statusText,
		headers: new Headers(params.source.headers)
	});
	try {
		Object.defineProperty(response, "url", {
			value: params.source.url || params.url,
			configurable: true
		});
	} catch {}
	return response;
}
async function fetchWithMatrixDispatcher(params) {
	return await fetchWithRuntimeDispatcherOrMockedGlobal(params.url, params.init);
}
async function fetchWithMatrixGuardedRedirects(params) {
	let currentUrl = new URL(params.url);
	let method = (params.init?.method ?? "GET").toUpperCase();
	let body = params.init?.body;
	let headers = new Headers(params.init?.headers ?? {});
	const maxRedirects = 5;
	const visited = /* @__PURE__ */ new Set();
	const { signal, cleanup } = buildTimeoutAbortSignal({
		timeoutMs: params.timeoutMs,
		signal: params.signal,
		operation: "matrix.guarded-redirect-fetch",
		url: params.url
	});
	for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
		let dispatcher;
		try {
			dispatcher = createPinnedDispatcher(await resolvePinnedHostnameWithPolicy(currentUrl.hostname, { policy: params.ssrfPolicy }), params.dispatcherPolicy, params.ssrfPolicy);
			const response = await fetchWithMatrixDispatcher({
				url: currentUrl.toString(),
				init: {
					...params.init,
					method,
					body,
					headers,
					redirect: "manual",
					signal,
					dispatcher
				}
			});
			if (!isRedirectStatus(response.status)) return {
				response,
				release: async () => {
					cleanup();
					await closeDispatcher(dispatcher);
				},
				finalUrl: currentUrl.toString()
			};
			const location = response.headers.get("location");
			if (!location) {
				cleanup();
				await closeDispatcher(dispatcher);
				throw new Error(`Matrix redirect missing location header (${currentUrl.toString()})`);
			}
			const nextUrl = new URL(location, currentUrl);
			if (nextUrl.protocol !== currentUrl.protocol) {
				cleanup();
				await closeDispatcher(dispatcher);
				throw new Error(`Blocked cross-protocol redirect (${currentUrl.protocol} -> ${nextUrl.protocol})`);
			}
			const nextUrlString = nextUrl.toString();
			if (visited.has(nextUrlString)) {
				cleanup();
				await closeDispatcher(dispatcher);
				throw new Error("Redirect loop detected");
			}
			visited.add(nextUrlString);
			if (nextUrl.origin !== currentUrl.origin) {
				headers = new Headers(headers);
				headers.delete("authorization");
			}
			if (response.status === 303 || (response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD") {
				method = "GET";
				body = void 0;
				headers = new Headers(headers);
				headers.delete("content-type");
				headers.delete("content-length");
			}
			response.body?.cancel();
			await closeDispatcher(dispatcher);
			currentUrl = nextUrl;
		} catch (error) {
			cleanup();
			await closeDispatcher(dispatcher);
			throw error;
		}
	}
	cleanup();
	throw new Error(`Too many redirects while requesting ${params.url}`);
}
function createMatrixGuardedFetch(params) {
	return (async (resource, init) => {
		const url = withoutMatrixStateAfterSyncParam(toFetchUrl(resource));
		const { signal, ...requestInit } = init ?? {};
		const { response, release } = await fetchWithMatrixGuardedRedirects({
			url,
			init: requestInit,
			signal: signal ?? void 0,
			ssrfPolicy: params.ssrfPolicy,
			dispatcherPolicy: params.dispatcherPolicy
		});
		try {
			return buildBufferedResponse({
				source: response,
				body: await response.arrayBuffer(),
				url
			});
		} finally {
			await release();
		}
	});
}
async function performMatrixRequest(params) {
	const isAbsoluteEndpoint = params.endpoint.startsWith("http://") || params.endpoint.startsWith("https://");
	if (isAbsoluteEndpoint && params.allowAbsoluteEndpoint !== true) throw new Error(`Absolute Matrix endpoint is blocked by default: ${params.endpoint}. Set allowAbsoluteEndpoint=true to opt in.`);
	const baseUrl = isAbsoluteEndpoint ? new URL(params.endpoint) : new URL(normalizeEndpoint(params.endpoint), params.homeserver);
	applyQuery(baseUrl, params.qs);
	const headers = new Headers();
	headers.set("Accept", params.raw ? "*/*" : "application/json");
	if (params.accessToken) headers.set("Authorization", `Bearer ${params.accessToken}`);
	let body;
	if (params.body !== void 0) if (params.body instanceof Uint8Array || params.body instanceof ArrayBuffer || typeof params.body === "string") body = params.body;
	else {
		headers.set("Content-Type", "application/json");
		body = JSON.stringify(params.body);
	}
	const { response, release } = await fetchWithMatrixGuardedRedirects({
		url: baseUrl.toString(),
		init: {
			method: params.method,
			headers,
			body
		},
		timeoutMs: params.timeoutMs,
		ssrfPolicy: params.ssrfPolicy,
		dispatcherPolicy: params.dispatcherPolicy
	});
	try {
		if (params.raw) {
			const contentLength = response.headers.get("content-length");
			if (params.maxBytes && contentLength) {
				const length = Number(contentLength);
				if (Number.isFinite(length) && length > params.maxBytes) throw new MatrixMediaSizeLimitError(`Matrix media exceeds configured size limit (${length} bytes > ${params.maxBytes} bytes)`);
			}
			const bytes = params.maxBytes ? await readResponseWithLimit(response, params.maxBytes, {
				onOverflow: ({ maxBytes, size }) => new MatrixMediaSizeLimitError(`Matrix media exceeds configured size limit (${size} bytes > ${maxBytes} bytes)`),
				chunkTimeoutMs: params.readIdleTimeoutMs
			}) : Buffer.from(await response.arrayBuffer());
			return {
				response,
				text: bytes.toString("utf8"),
				buffer: bytes
			};
		}
		const text = await response.text();
		return {
			response,
			text,
			buffer: Buffer.from(text, "utf8")
		};
	} finally {
		await release();
	}
}
//#endregion
//#region extensions/matrix/src/matrix/sdk/http-client.ts
var MatrixAuthedHttpClient = class {
	constructor(params) {
		this.homeserver = params.homeserver;
		this.accessToken = params.accessToken;
		this.ssrfPolicy = params.ssrfPolicy;
		this.dispatcherPolicy = params.dispatcherPolicy;
	}
	async requestJson(params) {
		const { response, text } = await performMatrixRequest({
			homeserver: this.homeserver,
			accessToken: this.accessToken,
			method: params.method,
			endpoint: params.endpoint,
			qs: params.qs,
			body: params.body,
			timeoutMs: params.timeoutMs,
			ssrfPolicy: this.ssrfPolicy,
			dispatcherPolicy: this.dispatcherPolicy,
			allowAbsoluteEndpoint: params.allowAbsoluteEndpoint
		});
		if (!response.ok) throw buildHttpError(response.status, text);
		if ((response.headers.get("content-type") ?? "").includes("application/json")) {
			if (!text.trim()) return {};
			return JSON.parse(text);
		}
		return text;
	}
	async requestRaw(params) {
		const { response, buffer } = await performMatrixRequest({
			homeserver: this.homeserver,
			accessToken: this.accessToken,
			method: params.method,
			endpoint: params.endpoint,
			qs: params.qs,
			timeoutMs: params.timeoutMs,
			raw: true,
			maxBytes: params.maxBytes,
			readIdleTimeoutMs: params.readIdleTimeoutMs,
			ssrfPolicy: this.ssrfPolicy,
			dispatcherPolicy: this.dispatcherPolicy,
			allowAbsoluteEndpoint: params.allowAbsoluteEndpoint
		});
		if (!response.ok) throw buildHttpError(response.status, buffer.toString("utf8"));
		return buffer;
	}
};
//#endregion
export { matrixEventToRaw as a, isMatrixMediaSizeLimitError as i, createMatrixGuardedFetch as n, parseMxc as o, MatrixMediaSizeLimitError as r, MatrixAuthedHttpClient as t };
