import { $t as resolveStateDir, Lt as resolvePreferredOpenClawTmpDir } from "./entry.js";
import { u as resolveAgentWorkspaceDir } from "./agent-scope-C2k6BQnt.js";
import { c as detectMime, l as extensionForMime } from "./image-ops-Z3_QkQPj.js";
import { t as fetchWithSsrFGuard } from "./fetch-guard-DVFm6--m.js";
import path from "node:path";

//#region src/media/read-response-with-limit.ts
async function readResponseWithLimit(res, maxBytes, opts) {
	const onOverflow = opts?.onOverflow ?? ((params) => /* @__PURE__ */ new Error(`Content too large: ${params.size} bytes (limit: ${params.maxBytes} bytes)`));
	const body = res.body;
	if (!body || typeof body.getReader !== "function") {
		const fallback = Buffer.from(await res.arrayBuffer());
		if (fallback.length > maxBytes) throw onOverflow({
			size: fallback.length,
			maxBytes,
			res
		});
		return fallback;
	}
	const reader = body.getReader();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value?.length) {
				total += value.length;
				if (total > maxBytes) {
					try {
						await reader.cancel();
					} catch {}
					throw onOverflow({
						size: total,
						maxBytes,
						res
					});
				}
				chunks.push(value);
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {}
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

//#endregion
//#region src/media/fetch.ts
var MediaFetchError = class extends Error {
	constructor(code, message) {
		super(message);
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
async function readErrorBodySnippet(res, maxChars = 200) {
	try {
		const text = await res.text();
		if (!text) return;
		const collapsed = text.replace(/\s+/g, " ").trim();
		if (!collapsed) return;
		if (collapsed.length <= maxChars) return collapsed;
		return `${collapsed.slice(0, maxChars)}…`;
	} catch {
		return;
	}
}
async function fetchRemoteMedia(options) {
	const { url, fetchImpl, requestInit, filePathHint, maxBytes, maxRedirects, ssrfPolicy, lookupFn } = options;
	let res;
	let finalUrl = url;
	let release = null;
	try {
		const result = await fetchWithSsrFGuard({
			url,
			fetchImpl,
			init: requestInit,
			maxRedirects,
			policy: ssrfPolicy,
			lookupFn
		});
		res = result.response;
		finalUrl = result.finalUrl;
		release = result.release;
	} catch (err) {
		throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${url}: ${String(err)}`);
	}
	try {
		if (!res.ok) {
			const statusText = res.statusText ? ` ${res.statusText}` : "";
			const redirected = finalUrl !== url ? ` (redirected to ${finalUrl})` : "";
			let detail = `HTTP ${res.status}${statusText}`;
			if (!res.body) detail = `HTTP ${res.status}${statusText}; empty response body`;
			else {
				const snippet = await readErrorBodySnippet(res);
				if (snippet) detail += `; body: ${snippet}`;
			}
			throw new MediaFetchError("http_error", `Failed to fetch media from ${url}${redirected}: ${detail}`);
		}
		const contentLength = res.headers.get("content-length");
		if (maxBytes && contentLength) {
			const length = Number(contentLength);
			if (Number.isFinite(length) && length > maxBytes) throw new MediaFetchError("max_bytes", `Failed to fetch media from ${url}: content length ${length} exceeds maxBytes ${maxBytes}`);
		}
		const buffer = maxBytes ? await readResponseWithLimit(res, maxBytes, { onOverflow: ({ maxBytes, res }) => new MediaFetchError("max_bytes", `Failed to fetch media from ${res.url || url}: payload exceeds maxBytes ${maxBytes}`) }) : Buffer.from(await res.arrayBuffer());
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
//#region src/media/local-roots.ts
let cachedPreferredTmpDir;
function resolveCachedPreferredTmpDir() {
	if (!cachedPreferredTmpDir) cachedPreferredTmpDir = resolvePreferredOpenClawTmpDir();
	return cachedPreferredTmpDir;
}
function buildMediaLocalRoots(stateDir, options = {}) {
	const resolvedStateDir = path.resolve(stateDir);
	return [
		options.preferredTmpDir ?? resolveCachedPreferredTmpDir(),
		path.join(resolvedStateDir, "media"),
		path.join(resolvedStateDir, "agents"),
		path.join(resolvedStateDir, "workspace"),
		path.join(resolvedStateDir, "sandboxes")
	];
}
function getDefaultMediaLocalRoots() {
	return buildMediaLocalRoots(resolveStateDir());
}
function getAgentScopedMediaLocalRoots(cfg, agentId) {
	const roots = buildMediaLocalRoots(resolveStateDir());
	if (!agentId?.trim()) return roots;
	const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
	if (!workspaceDir) return roots;
	const normalizedWorkspaceDir = path.resolve(workspaceDir);
	if (!roots.includes(normalizedWorkspaceDir)) roots.push(normalizedWorkspaceDir);
	return roots;
}

//#endregion
export { readResponseWithLimit as a, fetchRemoteMedia as i, getDefaultMediaLocalRoots as n, MediaFetchError as r, getAgentScopedMediaLocalRoots as t };