import { a as redactSensitiveText } from "./redact-R2-EdHUS.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { n as detectMime, p as MAX_DOCUMENT_BYTES, r as extensionForMime } from "./mime-Bg_OIUJn.js";
import { i as withStrictGuardedFetchMode, n as fetchWithSsrFGuard, o as withTrustedExplicitProxyGuardedFetchMode } from "./fetch-guard-B7xT8hT9.js";
import { n as readResponseWithLimit, t as readResponseTextSnippet } from "./read-response-with-limit-CcoEmJI7.js";
import path from "node:path";
//#region src/media/fetch.ts
const DEFAULT_FETCH_MEDIA_MAX_BYTES = MAX_DOCUMENT_BYTES;
var MediaFetchError = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
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
			return path.basename(decodeURIComponent(encoded));
		} catch {
			return path.basename(encoded);
		}
	}
	const match = /filename\s*=\s*([^;]+)/i.exec(header);
	if (match?.[1]) return path.basename(stripQuotes(match[1].trim()));
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
async function fetchRemoteMedia(options) {
	const { url, fetchImpl, requestInit, filePathHint, maxBytes, maxRedirects, readIdleTimeoutMs, ssrfPolicy, lookupFn, dispatcherPolicy, dispatcherAttempts, shouldRetryFetchError, trustExplicitProxyDns } = options;
	const sourceUrl = redactMediaUrl(url);
	let res;
	let finalUrl = url;
	let release = null;
	const attempts = dispatcherAttempts && dispatcherAttempts.length > 0 ? dispatcherAttempts : [{
		dispatcherPolicy,
		lookupFn
	}];
	const runGuardedFetch = async (attempt) => await fetchWithSsrFGuard((trustExplicitProxyDns && attempt.dispatcherPolicy?.mode === "explicit-proxy" ? withTrustedExplicitProxyGuardedFetchMode : withStrictGuardedFetchMode)({
		url,
		fetchImpl,
		init: requestInit,
		maxRedirects,
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
		res = result.response;
		finalUrl = result.finalUrl;
		release = result.release;
	} catch (err) {
		throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${sourceUrl}: ${formatErrorMessage(err)}`, { cause: err });
	}
	try {
		if (!res.ok) {
			const statusText = res.statusText ? ` ${res.statusText}` : "";
			const redirected = finalUrl !== url ? ` (redirected to ${redactMediaUrl(finalUrl)})` : "";
			let detail = `HTTP ${res.status}${statusText}`;
			if (!res.body) detail = `HTTP ${res.status}${statusText}; empty response body`;
			else {
				const snippet = await readErrorBodySnippet(res, { chunkTimeoutMs: readIdleTimeoutMs });
				if (snippet) detail += `; body: ${snippet}`;
			}
			throw new MediaFetchError("http_error", `Failed to fetch media from ${sourceUrl}${redirected}: ${redactSensitiveText(detail)}`);
		}
		const effectiveMaxBytes = maxBytes ?? DEFAULT_FETCH_MEDIA_MAX_BYTES;
		const contentLength = res.headers.get("content-length");
		if (contentLength) {
			const length = Number(contentLength);
			if (Number.isFinite(length) && length > effectiveMaxBytes) throw new MediaFetchError("max_bytes", `Failed to fetch media from ${sourceUrl}: content length ${length} exceeds maxBytes ${effectiveMaxBytes}`);
		}
		let buffer;
		try {
			buffer = await readResponseWithLimit(res, effectiveMaxBytes, {
				onOverflow: ({ maxBytes, res }) => new MediaFetchError("max_bytes", `Failed to fetch media from ${redactMediaUrl(res.url || url)}: payload exceeds maxBytes ${maxBytes}`),
				chunkTimeoutMs: readIdleTimeoutMs
			});
		} catch (err) {
			if (err instanceof MediaFetchError) throw err;
			throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${redactMediaUrl(res.url || url)}: ${formatErrorMessage(err)}`, { cause: err });
		}
		let fileNameFromUrl;
		try {
			const parsed = new URL(finalUrl);
			fileNameFromUrl = path.basename(parsed.pathname) || void 0;
		} catch {}
		const headerFileName = parseContentDispositionFileName(res.headers.get("content-disposition"));
		let fileName = headerFileName || fileNameFromUrl || (filePathHint ? path.basename(filePathHint) : void 0);
		const filePathForMime = headerFileName && path.extname(headerFileName) ? headerFileName : filePathHint ?? finalUrl;
		const contentType = await detectMime({
			buffer,
			headerMime: res.headers.get("content-type"),
			filePath: filePathForMime
		});
		if (fileName && !path.extname(fileName) && contentType) {
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
export { MediaFetchError as n, fetchRemoteMedia as r, DEFAULT_FETCH_MEDIA_MAX_BYTES as t };
