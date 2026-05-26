import { s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { a as isTransientNetworkError, n as isAbortError } from "./unhandled-rejections-Km9wbHjh.js";
import { n as detectMime, p as MAX_DOCUMENT_BYTES, r as extensionForMime } from "./mime-DppuT-pZ.js";
import { n as extnameFromAnyPath, t as basenameFromAnyPath } from "./file-name-r4prf02z.js";
import { f as saveMediaStream, u as saveMediaBuffer } from "./store-rQFzzX5P.js";
import { i as withStrictGuardedFetchMode, n as fetchWithSsrFGuard, o as withTrustedExplicitProxyGuardedFetchMode } from "./fetch-guard-BEAbHb5H.js";
import { n as retryAsync } from "./retry-CryZAmlE.js";
import { n as readResponseWithLimit, t as readResponseTextSnippet } from "./read-response-with-limit-S6PVjcFB.js";
//#region src/media/fetch.ts
const DEFAULT_FETCH_MEDIA_MAX_BYTES = MAX_DOCUMENT_BYTES;
var MediaFetchError = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.status = options?.status;
		this.name = "MediaFetchError";
	}
};
function stripQuotes(value) {
	return value.replace(/^["']|["']$/g, "");
}
function parseContentDispositionFileName(header) {
	if (!header) return;
	const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
	if (starMatch?.[1]) {
		const cleaned = stripQuotes(starMatch[1].trim());
		const encoded = cleaned.split("''").slice(1).join("''") || cleaned;
		try {
			return basenameFromAnyPath(decodeURIComponent(encoded));
		} catch {
			return basenameFromAnyPath(encoded);
		}
	}
	const match = /filename\s*=\s*([^;]+)/i.exec(header);
	if (match?.[1]) return basenameFromAnyPath(stripQuotes(match[1].trim()));
}
function basenameFromUrlPathname(pathname) {
	const base = basenameFromAnyPath(pathname);
	if (!base) return "";
	try {
		return decodeURIComponent(base).replace(/[\\/]/g, "_");
	} catch {
		return base;
	}
}
async function readErrorBodySnippet(res, opts) {
	try {
		return await readResponseTextSnippet(res, {
			maxBytes: 8 * 1024,
			maxChars: opts?.maxChars,
			chunkTimeoutMs: opts?.chunkTimeoutMs
		});
	} catch {
		return;
	}
}
function redactMediaUrl(url) {
	return redactSensitiveText(url);
}
async function fetchGuardedMediaResponse(options) {
	const { url, fetchImpl, requestInit, maxRedirects, timeoutMs, ssrfPolicy, lookupFn, dispatcherPolicy, dispatcherAttempts, shouldRetryFetchError, trustExplicitProxyDns } = options;
	const sourceUrl = redactMediaUrl(url);
	const attempts = dispatcherAttempts && dispatcherAttempts.length > 0 ? dispatcherAttempts : [{
		dispatcherPolicy,
		lookupFn
	}];
	const runGuardedFetch = async (attempt) => await fetchWithSsrFGuard((trustExplicitProxyDns && attempt.dispatcherPolicy?.mode === "explicit-proxy" ? withTrustedExplicitProxyGuardedFetchMode : withStrictGuardedFetchMode)({
		url,
		fetchImpl,
		init: requestInit,
		maxRedirects,
		...timeoutMs !== void 0 ? { timeoutMs } : {},
		policy: ssrfPolicy,
		lookupFn: attempt.lookupFn ?? lookupFn,
		dispatcherPolicy: attempt.dispatcherPolicy
	}));
	try {
		let result;
		const attemptErrors = [];
		for (let i = 0; i < attempts.length; i += 1) try {
			result = await runGuardedFetch(attempts[i]);
			break;
		} catch (err) {
			if (typeof shouldRetryFetchError !== "function" || !shouldRetryFetchError(err) || i === attempts.length - 1) {
				if (attemptErrors.length > 0) {
					const combined = new Error(`Primary fetch failed and fallback fetch also failed for ${sourceUrl}`, { cause: err });
					combined.primaryError = attemptErrors[0];
					combined.attemptErrors = [...attemptErrors, err];
					throw combined;
				}
				throw err;
			}
			attemptErrors.push(err);
		}
		return {
			response: result.response,
			finalUrl: result.finalUrl,
			release: result.release,
			sourceUrl
		};
	} catch (err) {
		throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${sourceUrl}: ${formatErrorMessage(err)}`, { cause: err });
	}
}
async function assertMediaResponseOk(params) {
	const { res, url, finalUrl, sourceUrl, readIdleTimeoutMs } = params;
	if (res.ok) return;
	const statusText = res.statusText ? ` ${res.statusText}` : "";
	const redirected = finalUrl !== url ? ` (redirected to ${redactMediaUrl(finalUrl)})` : "";
	let detail = `HTTP ${res.status}${statusText}`;
	if (!res.body) detail = `HTTP ${res.status}${statusText}; empty response body`;
	else {
		const snippet = await readErrorBodySnippet(res, { chunkTimeoutMs: readIdleTimeoutMs });
		if (snippet) detail += `; body: ${snippet}`;
	}
	throw new MediaFetchError("http_error", `Failed to fetch media from ${sourceUrl}${redirected}: ${redactSensitiveText(detail)}`, { status: res.status });
}
function assertMediaContentLength(params) {
	const contentLength = params.res.headers.get("content-length");
	if (!contentLength) return;
	const length = Number(contentLength);
	if (Number.isFinite(length) && length > params.maxBytes) throw new MediaFetchError("max_bytes", `Failed to fetch media from ${params.sourceUrl}: content length ${length} exceeds maxBytes ${params.maxBytes}`);
}
function resolveRemoteFileName(params) {
	let fileNameFromUrl;
	try {
		fileNameFromUrl = basenameFromUrlPathname(new URL(params.finalUrl).pathname) || void 0;
	} catch {}
	return parseContentDispositionFileName(params.res.headers.get("content-disposition")) || (params.filePathHint ? basenameFromAnyPath(params.filePathHint) : void 0) || fileNameFromUrl;
}
function isGenericResponseContentType(value) {
	const normalized = value?.split(";")[0]?.trim().toLowerCase();
	return !normalized || normalized === "application/octet-stream" || normalized === "binary/octet-stream" || normalized === "application/zip";
}
function resolveResponseContentType(params) {
	if (!params.fallbackContentType) return params.headerContentType ?? void 0;
	if (isGenericResponseContentType(params.headerContentType)) return params.fallbackContentType;
	const headerContentType = params.headerContentType?.split(";")[0]?.trim().toLowerCase();
	const fallbackContentType = params.fallbackContentType.split(";")[0]?.trim().toLowerCase();
	if (headerContentType?.startsWith("video/") && fallbackContentType?.startsWith("audio/") && headerContentType.slice(6) === fallbackContentType.slice(6)) return params.fallbackContentType;
	return params.headerContentType ?? params.fallbackContentType;
}
async function readChunkWithIdleTimeout(reader, chunkTimeoutMs) {
	let timeoutId;
	let timedOut = false;
	return await new Promise((resolve, reject) => {
		const clear = () => {
			if (timeoutId !== void 0) {
				clearTimeout(timeoutId);
				timeoutId = void 0;
			}
		};
		timeoutId = setTimeout(() => {
			timedOut = true;
			clear();
			reader.cancel().catch(() => void 0);
			reject(/* @__PURE__ */ new Error(`Media download stalled: no data received for ${chunkTimeoutMs}ms`));
		}, chunkTimeoutMs);
		reader.read().then((result) => {
			clear();
			if (!timedOut) resolve(result);
		}, (err) => {
			clear();
			if (!timedOut) reject(err);
		});
	});
}
async function* responseBodyChunks(body, readIdleTimeoutMs) {
	const reader = body.getReader();
	let completed = false;
	try {
		while (true) {
			const { done, value } = readIdleTimeoutMs ? await readChunkWithIdleTimeout(reader, readIdleTimeoutMs) : await reader.read();
			if (done) {
				completed = true;
				return;
			}
			if (value?.byteLength) yield value;
		}
	} finally {
		if (!completed) await reader.cancel().catch(() => void 0);
		try {
			reader.releaseLock();
		} catch {}
	}
}
function isMediaLimitError(err) {
	return err instanceof Error && /Media exceeds .* limit/.test(err.message);
}
async function saveOkMediaResponse(params) {
	assertMediaContentLength({
		res: params.res,
		sourceUrl: params.sourceUrl,
		maxBytes: params.maxBytes
	});
	const fileName = resolveRemoteFileName({
		res: params.res,
		finalUrl: params.finalUrl,
		filePathHint: params.filePathHint
	});
	const contentType = resolveResponseContentType({
		headerContentType: params.res.headers.get("content-type"),
		fallbackContentType: params.fallbackContentType
	});
	const detectionFilePathHint = isGenericResponseContentType(contentType) ? params.filePathHint : void 0;
	try {
		return {
			...params.res.body ? await saveMediaStream(responseBodyChunks(params.res.body, params.readIdleTimeoutMs), contentType ?? void 0, params.subdir ?? "inbound", params.maxBytes, params.originalFilename, detectionFilePathHint) : await saveMediaBuffer(Buffer.alloc(0), contentType ?? void 0, params.subdir ?? "inbound", params.maxBytes, params.originalFilename, detectionFilePathHint),
			...fileName ? { fileName } : {}
		};
	} catch (err) {
		if (err instanceof MediaFetchError) throw err;
		if (isMediaLimitError(err)) throw new MediaFetchError("max_bytes", `Failed to fetch media from ${params.sourceUrl}: payload exceeds maxBytes ${params.maxBytes}`, { cause: err });
		throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${params.sourceUrl}: ${formatErrorMessage(err)}`, { cause: err });
	}
}
function shouldRetryMediaFetch(err) {
	if (err instanceof MediaFetchError) {
		if (err.code === "max_bytes") return false;
		if (err.code === "http_error") return typeof err.status === "number" && (err.status === 408 || err.status >= 500);
		if (err.code === "fetch_failed") {
			if (isAbortError(err) || isAbortError(err.cause)) return false;
			return isTransientNetworkError(err.cause ?? err);
		}
		return false;
	}
	return isTransientNetworkError(err);
}
async function withMediaFetchRetry(options, fn) {
	const retry = options.retry;
	if (!retry) return await fn();
	const callerShouldRetry = retry.shouldRetry;
	return await retryAsync(fn, {
		label: "media:fetch",
		...retry,
		shouldRetry: (err, attempt) => callerShouldRetry ? callerShouldRetry(err, attempt) : shouldRetryMediaFetch(err)
	});
}
async function saveResponseMedia(res, options = {}) {
	const sourceUrl = redactMediaUrl((options.sourceUrl ?? res.url) || "response");
	const finalUrl = options.sourceUrl ?? res.url;
	await assertMediaResponseOk({
		res,
		url: options.sourceUrl ?? finalUrl,
		finalUrl,
		sourceUrl,
		readIdleTimeoutMs: options.readIdleTimeoutMs
	});
	return await saveOkMediaResponse({
		res,
		finalUrl,
		sourceUrl,
		filePathHint: options.filePathHint,
		maxBytes: options.maxBytes ?? DEFAULT_FETCH_MEDIA_MAX_BYTES,
		readIdleTimeoutMs: options.readIdleTimeoutMs,
		fallbackContentType: options.fallbackContentType,
		subdir: options.subdir,
		originalFilename: options.originalFilename
	});
}
async function saveRemoteMedia(options) {
	return await withMediaFetchRetry(options, () => saveRemoteMediaOnce(options));
}
async function saveRemoteMediaOnce(options) {
	const { response: res, finalUrl, release, sourceUrl } = await fetchGuardedMediaResponse(options);
	try {
		await assertMediaResponseOk({
			res,
			url: options.url,
			finalUrl,
			sourceUrl,
			readIdleTimeoutMs: options.readIdleTimeoutMs
		});
		return await saveOkMediaResponse({
			res,
			finalUrl,
			sourceUrl,
			filePathHint: options.filePathHint,
			maxBytes: options.maxBytes ?? DEFAULT_FETCH_MEDIA_MAX_BYTES,
			readIdleTimeoutMs: options.readIdleTimeoutMs,
			fallbackContentType: options.fallbackContentType,
			subdir: options.subdir,
			originalFilename: options.originalFilename
		});
	} finally {
		if (release) await release();
	}
}
async function readRemoteMediaBuffer(options) {
	return await withMediaFetchRetry(options, () => readRemoteMediaBufferOnce(options));
}
/** @deprecated Use `readRemoteMediaBuffer` for buffer reads or `saveRemoteMedia` for URL-to-store. */
const fetchRemoteMedia = readRemoteMediaBuffer;
async function readRemoteMediaBufferOnce(options) {
	const { response: res, finalUrl, release, sourceUrl } = await fetchGuardedMediaResponse(options);
	try {
		await assertMediaResponseOk({
			res,
			url: options.url,
			finalUrl,
			sourceUrl,
			readIdleTimeoutMs: options.readIdleTimeoutMs
		});
		const effectiveMaxBytes = options.maxBytes ?? DEFAULT_FETCH_MEDIA_MAX_BYTES;
		assertMediaContentLength({
			res,
			sourceUrl,
			maxBytes: effectiveMaxBytes
		});
		let buffer;
		try {
			buffer = await readResponseWithLimit(res, effectiveMaxBytes, {
				onOverflow: ({ maxBytes, res }) => new MediaFetchError("max_bytes", `Failed to fetch media from ${redactMediaUrl(res.url || options.url)}: payload exceeds maxBytes ${maxBytes}`),
				chunkTimeoutMs: options.readIdleTimeoutMs
			});
		} catch (err) {
			if (err instanceof MediaFetchError) throw err;
			throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${redactMediaUrl(res.url || options.url)}: ${formatErrorMessage(err)}`, { cause: err });
		}
		let fileName = resolveRemoteFileName({
			res,
			finalUrl,
			filePathHint: options.filePathHint
		});
		const filePathForMime = fileName && extnameFromAnyPath(fileName) ? fileName : options.filePathHint ?? finalUrl;
		const contentType = await detectMime({
			buffer,
			headerMime: res.headers.get("content-type"),
			filePath: filePathForMime
		});
		if (fileName && !extnameFromAnyPath(fileName) && contentType) {
			const ext = extensionForMime(contentType);
			if (ext) fileName = `${fileName}${ext}`;
		}
		return {
			buffer,
			contentType: contentType ?? void 0,
			fileName
		};
	} finally {
		if (release) await release();
	}
}
//#endregion
export { saveRemoteMedia as a, readRemoteMediaBuffer as i, MediaFetchError as n, saveResponseMedia as o, fetchRemoteMedia as r, DEFAULT_FETCH_MEDIA_MAX_BYTES as t };
