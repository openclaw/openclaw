import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { r as logVerbose } from "./globals-Dn_zSD2h.js";
import { t as pruneMapToMaxSize } from "./map-size-8pzJ-eHx.js";
import { t as fetchWithRuntimeDispatcher } from "./runtime-fetch-BqNJEWiI.js";
import { t as normalizeHostname } from "./hostname-qrpaemh7.js";
import { l as saveMediaBuffer } from "./store-BhTQkKvz.js";
import { r as fetchRemoteMedia } from "./fetch-Dq0yQNGS.js";
import "./text-runtime-CFBwIeh_.js";
import "./error-runtime-D_Qslcoe.js";
import { t as resolveRequestUrl } from "./request-url-BOvdy9pw.js";
import "./runtime-env-PjQ_OX8O.js";
import "./media-runtime-BFyCHDx4.js";
import "./runtime-fetch-DkcxwFig.js";
//#region extensions/slack/src/file-reference.ts
function formatSlackFileReference(file) {
	const name = normalizeOptionalString(file?.name) ?? "file";
	const fileId = normalizeOptionalString(file?.id);
	return fileId ? `${name} (fileId: ${fileId})` : name;
}
function formatSlackFileReferenceList(files) {
	if (!files?.length) return "file";
	return files.map((file) => formatSlackFileReference(file)).join(", ");
}
//#endregion
//#region extensions/slack/src/monitor/media-types.ts
const MAX_SLACK_MEDIA_FILES = 8;
//#endregion
//#region extensions/slack/src/monitor/thread.ts
const THREAD_STARTER_CACHE = /* @__PURE__ */ new Map();
const THREAD_STARTER_CACHE_TTL_MS = 360 * 6e4;
const THREAD_STARTER_CACHE_MAX = 2e3;
function evictThreadStarterCache() {
	const now = Date.now();
	for (const [cacheKey, entry] of THREAD_STARTER_CACHE.entries()) if (now - entry.cachedAt > THREAD_STARTER_CACHE_TTL_MS) THREAD_STARTER_CACHE.delete(cacheKey);
	pruneMapToMaxSize(THREAD_STARTER_CACHE, THREAD_STARTER_CACHE_MAX);
}
function formatSlackFilePlaceholder(files) {
	return `[attached: ${formatSlackFileReferenceList(files)}]`;
}
async function resolveSlackThreadStarter(params) {
	evictThreadStarterCache();
	const cacheKey = `${params.channelId}:${params.threadTs}`;
	const cached = THREAD_STARTER_CACHE.get(cacheKey);
	if (cached && Date.now() - cached.cachedAt <= THREAD_STARTER_CACHE_TTL_MS) return cached.value;
	if (cached) THREAD_STARTER_CACHE.delete(cacheKey);
	try {
		const message = (await params.client.conversations.replies({
			channel: params.channelId,
			ts: params.threadTs,
			limit: 1,
			inclusive: true
		}))?.messages?.[0];
		const text = (message?.text ?? "").trim();
		const files = message?.files?.length ? message.files : void 0;
		if (!message || !text && !files) return null;
		const starter = {
			text: text || formatSlackFilePlaceholder(files),
			userId: message.user,
			botId: message.bot_id,
			ts: message.ts,
			files
		};
		if (THREAD_STARTER_CACHE.has(cacheKey)) THREAD_STARTER_CACHE.delete(cacheKey);
		THREAD_STARTER_CACHE.set(cacheKey, {
			value: starter,
			cachedAt: Date.now()
		});
		evictThreadStarterCache();
		return starter;
	} catch (err) {
		logVerbose(`slack thread starter fetch failed channel=${params.channelId} ts=${params.threadTs}: ${formatErrorMessage(err)}`);
		return null;
	}
}
function resetSlackThreadStarterCacheForTest() {
	THREAD_STARTER_CACHE.clear();
}
/**
* Fetches the most recent messages in a Slack thread (excluding the current message).
* Used to populate thread context when a new thread session starts.
*
* Uses cursor pagination and keeps only the latest N retained messages so long threads
* still produce up-to-date context without unbounded memory growth.
*/
async function resolveSlackThreadHistory(params) {
	const maxMessages = params.limit ?? 20;
	if (!Number.isFinite(maxMessages) || maxMessages <= 0) return [];
	const fetchLimit = 200;
	const retained = [];
	let cursor;
	try {
		do {
			const response = await params.client.conversations.replies({
				channel: params.channelId,
				ts: params.threadTs,
				limit: fetchLimit,
				inclusive: true,
				...cursor ? { cursor } : {}
			});
			for (const msg of response.messages ?? []) {
				if (!msg.text?.trim() && !msg.files?.length) continue;
				if (params.currentMessageTs && msg.ts === params.currentMessageTs) continue;
				retained.push(msg);
				if (retained.length > maxMessages) retained.shift();
			}
			const next = response.response_metadata?.next_cursor;
			cursor = typeof next === "string" && next.trim().length > 0 ? next.trim() : void 0;
		} while (cursor);
		return retained.map((msg) => ({
			text: msg.text?.trim() ? msg.text : formatSlackFilePlaceholder(msg.files),
			userId: msg.user,
			botId: msg.bot_id,
			ts: msg.ts,
			files: msg.files
		}));
	} catch (err) {
		logVerbose(`slack thread history fetch failed channel=${params.channelId} ts=${params.threadTs}: ${formatErrorMessage(err)}`);
		return [];
	}
}
//#endregion
//#region extensions/slack/src/monitor/media.ts
function normalizeLowercaseStringOrEmpty(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function normalizeOptionalLowercaseString(value) {
	return normalizeLowercaseStringOrEmpty(value) || void 0;
}
function isSlackHostname(hostname) {
	const normalized = normalizeHostname(hostname);
	if (!normalized) return false;
	return [
		"slack.com",
		"slack-edge.com",
		"slack-files.com"
	].some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}
function assertSlackFileUrl(rawUrl) {
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid Slack file URL: ${rawUrl}`);
	}
	if (parsed.protocol !== "https:") throw new Error(`Refusing Slack file URL with non-HTTPS protocol: ${parsed.protocol}`);
	if (!isSlackHostname(parsed.hostname)) throw new Error(`Refusing to send Slack token to non-Slack host "${parsed.hostname}" (url: ${rawUrl})`);
	return parsed;
}
function createSlackAuthHeaders(token) {
	return { Authorization: `Bearer ${token}` };
}
function createSlackMediaRequest(url, token) {
	return {
		url: assertSlackFileUrl(url).href,
		requestInit: { headers: createSlackAuthHeaders(token) }
	};
}
function isMockedFetch(fetchImpl) {
	if (typeof fetchImpl !== "function") return false;
	return typeof fetchImpl.mock === "object";
}
function createSlackMediaFetch() {
	return async (input, init) => {
		const url = resolveRequestUrl(input);
		if (!url) throw new Error("Unsupported fetch input: expected string, URL, or Request");
		const parsed = assertSlackFileUrl(url);
		return ("dispatcher" in (init ?? {}) && !isMockedFetch(globalThis.fetch) ? fetchWithRuntimeDispatcher : globalThis.fetch)(parsed.href, {
			...init,
			redirect: "manual"
		});
	};
}
function resolveSlackFetchForRuntime() {
	return isMockedFetch(globalThis.fetch) ? globalThis.fetch : fetchWithRuntimeDispatcher;
}
/**
* Fetches a URL with Authorization header while keeping same-origin redirects
* authenticated and dropping auth once the redirect crosses origins.
*/
async function fetchWithSlackAuth(url, token) {
	const parsed = assertSlackFileUrl(url);
	const authHeaders = createSlackAuthHeaders(token);
	const fetchImpl = resolveSlackFetchForRuntime();
	const initialRes = await fetchImpl(parsed.href, {
		headers: authHeaders,
		redirect: "manual"
	});
	if (initialRes.status < 300 || initialRes.status >= 400) return initialRes;
	const redirectUrl = initialRes.headers.get("location");
	if (!redirectUrl) return initialRes;
	const resolvedUrl = new URL(redirectUrl, parsed.href);
	if (resolvedUrl.protocol !== "https:") return initialRes;
	if (resolvedUrl.origin === parsed.origin) return fetchImpl(resolvedUrl.toString(), {
		headers: authHeaders,
		redirect: "follow"
	});
	return fetchImpl(resolvedUrl.toString(), { redirect: "follow" });
}
const SLACK_MEDIA_SSRF_POLICY = {
	allowedHostnames: [
		"*.slack.com",
		"*.slack-edge.com",
		"*.slack-files.com"
	],
	hostnameAllowlist: [
		"*.slack.com",
		"*.slack-edge.com",
		"*.slack-files.com"
	],
	allowRfc2544BenchmarkRange: true
};
const SLACK_MEDIA_READ_IDLE_TIMEOUT_MS = 6e4;
const SLACK_MEDIA_TOTAL_TIMEOUT_MS = 12e4;
function mergeAbortSignals(signals) {
	const activeSignals = signals.filter((signal) => Boolean(signal));
	if (activeSignals.length === 0) return;
	if (activeSignals.length === 1) return activeSignals[0];
	if (typeof AbortSignal.any === "function") return AbortSignal.any(activeSignals);
	const controller = new AbortController();
	for (const signal of activeSignals) if (signal.aborted) {
		controller.abort();
		return controller.signal;
	}
	const abort = () => {
		controller.abort();
		for (const signal of activeSignals) signal.removeEventListener("abort", abort);
	};
	for (const signal of activeSignals) signal.addEventListener("abort", abort, { once: true });
	return controller.signal;
}
async function fetchSlackMedia(params) {
	const timeoutAbortController = params.totalTimeoutMs ? new AbortController() : void 0;
	const signal = mergeAbortSignals([
		params.abortSignal,
		params.options.requestInit?.signal ?? void 0,
		timeoutAbortController?.signal
	]);
	let timedOut = false;
	let timeoutHandle = null;
	const fetchPromise = fetchRemoteMedia({
		...params.options,
		readIdleTimeoutMs: params.readIdleTimeoutMs ?? 6e4,
		...signal ? { requestInit: {
			...params.options.requestInit,
			signal
		} } : {}
	}).catch((error) => {
		if (timedOut) return new Promise(() => {});
		throw error;
	});
	try {
		if (!params.totalTimeoutMs) return await fetchPromise;
		const timeoutPromise = new Promise((_, reject) => {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				timeoutAbortController?.abort();
				reject(/* @__PURE__ */ new Error(`slack media download timed out after ${params.totalTimeoutMs}ms`));
			}, params.totalTimeoutMs);
			timeoutHandle.unref?.();
		});
		return await Promise.race([fetchPromise, timeoutPromise]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}
/**
* Slack voice messages (audio clips, huddle recordings) carry a `subtype` of
* `"slack_audio"` but are served with a `video/*` MIME type (e.g. `video/mp4`,
* `video/webm`).  Override the primary type to `audio/` so the
* media-understanding pipeline routes them to transcription.
*/
function resolveSlackMediaMimetype(file, fetchedContentType) {
	const mime = fetchedContentType ?? file.mimetype;
	if (file.subtype === "slack_audio" && mime?.startsWith("video/")) return mime.replace("video/", "audio/");
	return mime;
}
function looksLikeHtmlBuffer(buffer) {
	const head = normalizeLowercaseStringOrEmpty(buffer.subarray(0, 512).toString("utf-8").replace(/^\s+/, ""));
	return head.startsWith("<!doctype html") || head.startsWith("<html");
}
const MAX_SLACK_MEDIA_CONCURRENCY = 3;
const MAX_SLACK_FORWARDED_ATTACHMENTS = 8;
function isForwardedSlackAttachment(attachment) {
	return attachment.is_share === true;
}
function resolveForwardedAttachmentImageUrl(attachment) {
	const rawUrl = attachment.image_url?.trim();
	if (!rawUrl) return null;
	try {
		const parsed = new URL(rawUrl);
		if (parsed.protocol !== "https:" || !isSlackHostname(parsed.hostname)) return null;
		return parsed.toString();
	} catch {
		return null;
	}
}
async function mapLimit(items, limit, fn) {
	if (items.length === 0) return [];
	const results = [];
	results.length = items.length;
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: workerCount }, async () => {
		while (true) {
			const idx = nextIndex++;
			if (idx >= items.length) return;
			results[idx] = await fn(items[idx]);
		}
	}));
	return results;
}
/**
* Downloads all files attached to a Slack message and returns them as an array.
* Returns `null` when no files could be downloaded.
*/
async function resolveSlackMedia(params) {
	const files = params.files ?? [];
	const results = (await mapLimit(files.length > 8 ? files.slice(0, 8) : files, MAX_SLACK_MEDIA_CONCURRENCY, async (file) => {
		const url = file.url_private_download ?? file.url_private;
		if (!url) return null;
		try {
			const { url: slackUrl, requestInit } = createSlackMediaRequest(url, params.token);
			const fetched = await fetchSlackMedia({
				options: {
					url: slackUrl,
					fetchImpl: createSlackMediaFetch(),
					requestInit,
					filePathHint: file.name,
					maxBytes: params.maxBytes,
					ssrfPolicy: SLACK_MEDIA_SSRF_POLICY
				},
				readIdleTimeoutMs: params.readIdleTimeoutMs,
				totalTimeoutMs: params.totalTimeoutMs ?? 12e4,
				abortSignal: params.abortSignal
			});
			if (fetched.buffer.byteLength > params.maxBytes) return null;
			const fileMime = normalizeOptionalLowercaseString(file.mimetype);
			const fileName = normalizeLowercaseStringOrEmpty(file.name);
			if (!(fileMime === "text/html" || fileName.endsWith(".html") || fileName.endsWith(".htm"))) {
				if (normalizeOptionalLowercaseString(fetched.contentType?.split(";")[0]) === "text/html" || looksLikeHtmlBuffer(fetched.buffer)) return null;
			}
			const effectiveMime = resolveSlackMediaMimetype(file, fetched.contentType);
			const saved = await saveMediaBuffer(fetched.buffer, effectiveMime, "inbound", params.maxBytes);
			const label = fetched.fileName ?? file.name;
			const contentType = effectiveMime ?? saved.contentType;
			return {
				path: saved.path,
				...contentType ? { contentType } : {},
				placeholder: `[Slack file: ${formatSlackFileReference({
					...file,
					name: label
				})}]`
			};
		} catch {
			return null;
		}
	})).filter((entry) => Boolean(entry));
	return results.length > 0 ? results : null;
}
/** Extracts text and media from forwarded-message attachments. Returns null when empty. */
async function resolveSlackAttachmentContent(params) {
	const attachments = params.attachments;
	if (!attachments || attachments.length === 0) return null;
	const forwardedAttachments = attachments.filter((attachment) => isForwardedSlackAttachment(attachment)).slice(0, MAX_SLACK_FORWARDED_ATTACHMENTS);
	if (forwardedAttachments.length === 0) return null;
	const textBlocks = [];
	const allMedia = [];
	for (const att of forwardedAttachments) {
		const text = att.text?.trim() || att.fallback?.trim();
		if (text) {
			const author = att.author_name;
			const heading = author ? `[Forwarded message from ${author}]` : "[Forwarded message]";
			textBlocks.push(`${heading}\n${text}`);
		}
		const imageUrl = resolveForwardedAttachmentImageUrl(att);
		if (imageUrl) try {
			const { url: slackUrl, requestInit } = createSlackMediaRequest(imageUrl, params.token);
			const fetched = await fetchSlackMedia({
				options: {
					url: slackUrl,
					fetchImpl: createSlackMediaFetch(),
					requestInit,
					maxBytes: params.maxBytes,
					ssrfPolicy: SLACK_MEDIA_SSRF_POLICY
				},
				readIdleTimeoutMs: params.readIdleTimeoutMs,
				totalTimeoutMs: params.totalTimeoutMs ?? 12e4,
				abortSignal: params.abortSignal
			});
			if (fetched.buffer.byteLength <= params.maxBytes) {
				const saved = await saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", params.maxBytes);
				const label = fetched.fileName ?? "forwarded image";
				allMedia.push({
					path: saved.path,
					contentType: fetched.contentType ?? saved.contentType,
					placeholder: `[Forwarded image: ${label}]`
				});
			}
		} catch {}
		if (att.files && att.files.length > 0) {
			const fileMedia = await resolveSlackMedia({
				files: att.files,
				token: params.token,
				maxBytes: params.maxBytes,
				readIdleTimeoutMs: params.readIdleTimeoutMs,
				totalTimeoutMs: params.totalTimeoutMs,
				abortSignal: params.abortSignal
			});
			if (fileMedia) allMedia.push(...fileMedia);
		}
	}
	const combinedText = textBlocks.join("\n\n");
	if (!combinedText && allMedia.length === 0) return null;
	return {
		text: combinedText,
		media: allMedia
	};
}
//#endregion
export { resolveSlackMedia as a, resolveSlackThreadStarter as c, resolveSlackAttachmentContent as i, MAX_SLACK_MEDIA_FILES as l, SLACK_MEDIA_TOTAL_TIMEOUT_MS as n, resetSlackThreadStarterCacheForTest as o, fetchWithSlackAuth as r, resolveSlackThreadHistory as s, SLACK_MEDIA_READ_IDLE_TIMEOUT_MS as t, formatSlackFileReference as u };
