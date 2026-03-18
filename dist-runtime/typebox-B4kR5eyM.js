import { a as init_types_secrets, c as normalizeResolvedSecretInputString } from "./types.secrets-Br5ssFsN.js";
import { a as readResponseText, c as writeCache, d as withTrustedWebToolsEndpoint, i as readCache, n as wrapWebContent, o as resolveCacheTtlMs, r as normalizeCacheKey, t as wrapExternalContent } from "./external-content-CxoN_TKD.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CZ08wtw1.js";
import { Type } from "@sinclair/typebox";
//#region src/agents/tools/web-fetch-visibility.ts
const HIDDEN_STYLE_PATTERNS = [
	["display", /^\s*none\s*$/i],
	["visibility", /^\s*hidden\s*$/i],
	["opacity", /^\s*0\s*$/],
	["font-size", /^\s*0(px|em|rem|pt|%)?\s*$/i],
	["text-indent", /^\s*-\d{4,}px\s*$/],
	["color", /^\s*transparent\s*$/i],
	["color", /^\s*rgba\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)\s*$/i],
	["color", /^\s*hsla\s*\(\s*[\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*0(?:\.0+)?\s*\)\s*$/i]
];
const HIDDEN_CLASS_NAMES = new Set([
	"sr-only",
	"visually-hidden",
	"d-none",
	"hidden",
	"invisible",
	"screen-reader-only",
	"offscreen"
]);
function hasHiddenClass(className) {
	return className.toLowerCase().split(/\s+/).some((cls) => HIDDEN_CLASS_NAMES.has(cls));
}
function isStyleHidden(style) {
	for (const [prop, pattern] of HIDDEN_STYLE_PATTERNS) {
		const escapedProp = prop.replace(/-/g, "\\-");
		const match = style.match(new RegExp(`(?:^|;)\\s*${escapedProp}\\s*:\\s*([^;]+)`, "i"));
		if (match && pattern.test(match[1])) return true;
	}
	const clipPath = style.match(/(?:^|;)\s*clip-path\s*:\s*([^;]+)/i);
	if (clipPath && !/^\s*none\s*$/i.test(clipPath[1])) {
		if (/inset\s*\(\s*(?:0*\.\d+|[1-9]\d*(?:\.\d+)?)%/i.test(clipPath[1])) return true;
	}
	const transform = style.match(/(?:^|;)\s*transform\s*:\s*([^;]+)/i);
	if (transform) {
		if (/scale\s*\(\s*0\s*\)/i.test(transform[1])) return true;
		if (/translateX\s*\(\s*-\d{4,}px\s*\)/i.test(transform[1])) return true;
		if (/translateY\s*\(\s*-\d{4,}px\s*\)/i.test(transform[1])) return true;
	}
	const width = style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i);
	const height = style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i);
	const overflow = style.match(/(?:^|;)\s*overflow\s*:\s*([^;]+)/i);
	if (width && /^\s*0(px)?\s*$/i.test(width[1]) && height && /^\s*0(px)?\s*$/i.test(height[1]) && overflow && /^\s*hidden\s*$/i.test(overflow[1])) return true;
	const left = style.match(/(?:^|;)\s*left\s*:\s*([^;]+)/i);
	const top = style.match(/(?:^|;)\s*top\s*:\s*([^;]+)/i);
	if (left && /^\s*-\d{4,}px\s*$/i.test(left[1])) return true;
	if (top && /^\s*-\d{4,}px\s*$/i.test(top[1])) return true;
	return false;
}
function shouldRemoveElement(element) {
	const tagName = element.tagName.toLowerCase();
	if ([
		"meta",
		"template",
		"svg",
		"canvas",
		"iframe",
		"object",
		"embed"
	].includes(tagName)) return true;
	if (tagName === "input" && element.getAttribute("type")?.toLowerCase() === "hidden") return true;
	if (element.getAttribute("aria-hidden") === "true") return true;
	if (element.hasAttribute("hidden")) return true;
	if (hasHiddenClass(element.getAttribute("class") ?? "")) return true;
	const style = element.getAttribute("style") ?? "";
	if (style && isStyleHidden(style)) return true;
	return false;
}
async function sanitizeHtml(html) {
	let sanitized = html.replace(/<!--[\s\S]*?-->/g, "");
	let document;
	try {
		const { parseHTML } = await import("linkedom");
		({document} = parseHTML(sanitized));
	} catch {
		return sanitized;
	}
	const all = Array.from(document.querySelectorAll("*"));
	for (let i = all.length - 1; i >= 0; i--) {
		const el = all[i];
		if (shouldRemoveElement(el)) el.parentNode?.removeChild(el);
	}
	return document.toString();
}
const INVISIBLE_UNICODE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;
function stripInvisibleUnicode(text) {
	return text.replace(INVISIBLE_UNICODE_RE, "");
}
//#endregion
//#region src/agents/tools/web-fetch-utils.ts
const READABILITY_MAX_HTML_CHARS = 1e6;
const READABILITY_MAX_ESTIMATED_NESTING_DEPTH = 3e3;
let readabilityDepsPromise;
async function loadReadabilityDeps() {
	if (!readabilityDepsPromise) readabilityDepsPromise = Promise.all([import("@mozilla/readability"), import("linkedom")]).then(([readability, linkedom]) => ({
		Readability: readability.Readability,
		parseHTML: linkedom.parseHTML
	}));
	try {
		return await readabilityDepsPromise;
	} catch (error) {
		readabilityDepsPromise = void 0;
		throw error;
	}
}
function decodeEntities(value) {
	return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}
function stripTags(value) {
	return decodeEntities(value.replace(/<[^>]+>/g, ""));
}
function normalizeWhitespace(value) {
	return value.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}
function htmlToMarkdown(html) {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : void 0;
	let text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
	text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
		const label = normalizeWhitespace(stripTags(body));
		if (!label) return href;
		return `[${label}](${href})`;
	});
	text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
		return `\n${"#".repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))))} ${normalizeWhitespace(stripTags(body))}\n`;
	});
	text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
		const label = normalizeWhitespace(stripTags(body));
		return label ? `\n- ${label}` : "";
	});
	text = text.replace(/<(br|hr)\s*\/?>/gi, "\n").replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, "\n");
	text = stripTags(text);
	text = normalizeWhitespace(text);
	return {
		text,
		title
	};
}
function markdownToText(markdown) {
	let text = markdown;
	text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
	text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
	text = text.replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, "").replace(/```/g, ""));
	text = text.replace(/`([^`]+)`/g, "$1");
	text = text.replace(/^#{1,6}\s+/gm, "");
	text = text.replace(/^\s*[-*+]\s+/gm, "");
	text = text.replace(/^\s*\d+\.\s+/gm, "");
	return normalizeWhitespace(text);
}
function truncateText(value, maxChars) {
	if (value.length <= maxChars) return {
		text: value,
		truncated: false
	};
	return {
		text: value.slice(0, maxChars),
		truncated: true
	};
}
function exceedsEstimatedHtmlNestingDepth(html, maxDepth) {
	const voidTags = new Set([
		"area",
		"base",
		"br",
		"col",
		"embed",
		"hr",
		"img",
		"input",
		"link",
		"meta",
		"param",
		"source",
		"track",
		"wbr"
	]);
	let depth = 0;
	const len = html.length;
	for (let i = 0; i < len; i++) {
		if (html.charCodeAt(i) !== 60) continue;
		const next = html.charCodeAt(i + 1);
		if (next === 33 || next === 63) continue;
		let j = i + 1;
		let closing = false;
		if (html.charCodeAt(j) === 47) {
			closing = true;
			j += 1;
		}
		while (j < len && html.charCodeAt(j) <= 32) j += 1;
		const nameStart = j;
		while (j < len) {
			const c = html.charCodeAt(j);
			if (!(c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 58 || c === 45)) break;
			j += 1;
		}
		const tagName = html.slice(nameStart, j).toLowerCase();
		if (!tagName) continue;
		if (closing) {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (voidTags.has(tagName)) continue;
		let selfClosing = false;
		for (let k = j; k < len && k < j + 200; k++) if (html.charCodeAt(k) === 62) {
			if (html.charCodeAt(k - 1) === 47) selfClosing = true;
			break;
		}
		if (selfClosing) continue;
		depth += 1;
		if (depth > maxDepth) return true;
	}
	return false;
}
async function extractBasicHtmlContent(params) {
	const cleanHtml = await sanitizeHtml(params.html);
	const rendered = htmlToMarkdown(cleanHtml);
	if (params.extractMode === "text") {
		const text = stripInvisibleUnicode(markdownToText(rendered.text)) || stripInvisibleUnicode(normalizeWhitespace(stripTags(cleanHtml)));
		return text ? {
			text,
			title: rendered.title
		} : null;
	}
	const text = stripInvisibleUnicode(rendered.text);
	return text ? {
		text,
		title: rendered.title
	} : null;
}
async function extractReadableContent(params) {
	const cleanHtml = await sanitizeHtml(params.html);
	if (cleanHtml.length > READABILITY_MAX_HTML_CHARS || exceedsEstimatedHtmlNestingDepth(cleanHtml, READABILITY_MAX_ESTIMATED_NESTING_DEPTH)) return null;
	try {
		const { Readability, parseHTML } = await loadReadabilityDeps();
		const { document } = parseHTML(cleanHtml);
		try {
			document.baseURI = params.url;
		} catch {}
		const parsed = new Readability(document, { charThreshold: 0 }).parse();
		if (!parsed?.content) return null;
		const title = parsed.title || void 0;
		if (params.extractMode === "text") {
			const text = stripInvisibleUnicode(normalizeWhitespace(parsed.textContent ?? ""));
			return text ? {
				text,
				title
			} : null;
		}
		const rendered = htmlToMarkdown(parsed.content);
		const text = stripInvisibleUnicode(rendered.text);
		return text ? {
			text,
			title: title ?? rendered.title
		} : null;
	} catch {
		return null;
	}
}
//#endregion
//#region extensions/firecrawl/src/config.ts
init_types_secrets();
const DEFAULT_FIRECRAWL_MAX_AGE_MS = 1728e5;
function resolveSearchConfig(cfg) {
	const search = cfg?.tools?.web?.search;
	if (!search || typeof search !== "object") return;
	return search;
}
function resolveFetchConfig(cfg) {
	const fetch = cfg?.tools?.web?.fetch;
	if (!fetch || typeof fetch !== "object") return;
	return fetch;
}
function resolveFirecrawlSearchConfig(cfg) {
	const search = resolveSearchConfig(cfg);
	if (!search || typeof search !== "object") return;
	const firecrawl = "firecrawl" in search ? search.firecrawl : void 0;
	if (!firecrawl || typeof firecrawl !== "object") return;
	return firecrawl;
}
function resolveFirecrawlFetchConfig(cfg) {
	const fetch = resolveFetchConfig(cfg);
	if (!fetch || typeof fetch !== "object") return;
	const firecrawl = "firecrawl" in fetch ? fetch.firecrawl : void 0;
	if (!firecrawl || typeof firecrawl !== "object") return;
	return firecrawl;
}
function normalizeConfiguredSecret(value, path) {
	return normalizeSecretInput(normalizeResolvedSecretInputString({
		value,
		path
	}));
}
function resolveFirecrawlApiKey(cfg) {
	const search = resolveFirecrawlSearchConfig(cfg);
	const fetch = resolveFirecrawlFetchConfig(cfg);
	return normalizeConfiguredSecret(search?.apiKey, "tools.web.search.firecrawl.apiKey") || normalizeConfiguredSecret(fetch?.apiKey, "tools.web.fetch.firecrawl.apiKey") || normalizeSecretInput(process.env.FIRECRAWL_API_KEY) || void 0;
}
function resolveFirecrawlBaseUrl(cfg) {
	const search = resolveFirecrawlSearchConfig(cfg);
	const fetch = resolveFirecrawlFetchConfig(cfg);
	return (typeof search?.baseUrl === "string" ? search.baseUrl.trim() : "") || (typeof fetch?.baseUrl === "string" ? fetch.baseUrl.trim() : "") || normalizeSecretInput(process.env.FIRECRAWL_BASE_URL) || "https://api.firecrawl.dev";
}
function resolveFirecrawlOnlyMainContent(cfg, override) {
	if (typeof override === "boolean") return override;
	const fetch = resolveFirecrawlFetchConfig(cfg);
	if (typeof fetch?.onlyMainContent === "boolean") return fetch.onlyMainContent;
	return true;
}
function resolveFirecrawlMaxAgeMs(cfg, override) {
	if (typeof override === "number" && Number.isFinite(override) && override >= 0) return Math.floor(override);
	const fetch = resolveFirecrawlFetchConfig(cfg);
	if (typeof fetch?.maxAgeMs === "number" && Number.isFinite(fetch.maxAgeMs) && fetch.maxAgeMs >= 0) return Math.floor(fetch.maxAgeMs);
	return DEFAULT_FIRECRAWL_MAX_AGE_MS;
}
function resolveFirecrawlScrapeTimeoutSeconds(cfg, override) {
	if (typeof override === "number" && Number.isFinite(override) && override > 0) return Math.floor(override);
	const fetch = resolveFirecrawlFetchConfig(cfg);
	if (typeof fetch?.timeoutSeconds === "number" && Number.isFinite(fetch.timeoutSeconds) && fetch.timeoutSeconds > 0) return Math.floor(fetch.timeoutSeconds);
	return 60;
}
function resolveFirecrawlSearchTimeoutSeconds(override) {
	if (typeof override === "number" && Number.isFinite(override) && override > 0) return Math.floor(override);
	return 30;
}
//#endregion
//#region extensions/firecrawl/src/firecrawl-client.ts
const SEARCH_CACHE = /* @__PURE__ */ new Map();
const SCRAPE_CACHE = /* @__PURE__ */ new Map();
const DEFAULT_SEARCH_COUNT = 5;
const DEFAULT_SCRAPE_MAX_CHARS = 5e4;
const DEFAULT_ERROR_MAX_BYTES = 64e3;
function resolveEndpoint(baseUrl, pathname) {
	const trimmed = baseUrl.trim();
	if (!trimmed) return new URL(pathname, "https://api.firecrawl.dev").toString();
	try {
		const url = new URL(trimmed);
		if (url.pathname && url.pathname !== "/") return url.toString();
		url.pathname = pathname;
		return url.toString();
	} catch {
		return new URL(pathname, "https://api.firecrawl.dev").toString();
	}
}
function resolveSiteName(urlRaw) {
	try {
		return new URL(urlRaw).hostname.replace(/^www\./, "") || void 0;
	} catch {
		return;
	}
}
async function postFirecrawlJson(params) {
	return await withTrustedWebToolsEndpoint({
		url: resolveEndpoint(params.baseUrl, params.pathname),
		timeoutSeconds: params.timeoutSeconds,
		init: {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${params.apiKey}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify(params.body)
		}
	}, async ({ response }) => {
		if (!response.ok) {
			const detail = await readResponseText(response, { maxBytes: DEFAULT_ERROR_MAX_BYTES });
			throw new Error(`${params.errorLabel} API error (${response.status}): ${detail.text || response.statusText}`);
		}
		const payload = await response.json();
		if (payload.success === false) {
			const error = typeof payload.error === "string" ? payload.error : typeof payload.message === "string" ? payload.message : "unknown error";
			throw new Error(`${params.errorLabel} API error: ${error}`);
		}
		return payload;
	});
}
function resolveSearchItems(payload) {
	const rawItems = [
		payload.data,
		payload.results,
		payload.data?.results,
		payload.data?.data,
		payload.data?.web,
		payload.web?.results
	].find((candidate) => Array.isArray(candidate));
	if (!Array.isArray(rawItems)) return [];
	const items = [];
	for (const entry of rawItems) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry;
		const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : void 0;
		const url = typeof record.url === "string" && record.url || typeof record.sourceURL === "string" && record.sourceURL || typeof record.sourceUrl === "string" && record.sourceUrl || typeof metadata?.sourceURL === "string" && metadata.sourceURL || "";
		if (!url) continue;
		const title = typeof record.title === "string" && record.title || typeof metadata?.title === "string" && metadata.title || "";
		const description = typeof record.description === "string" && record.description || typeof record.snippet === "string" && record.snippet || typeof record.summary === "string" && record.summary || void 0;
		const content = typeof record.markdown === "string" && record.markdown || typeof record.content === "string" && record.content || typeof record.text === "string" && record.text || void 0;
		const published = typeof record.publishedDate === "string" && record.publishedDate || typeof record.published === "string" && record.published || typeof metadata?.publishedTime === "string" && metadata.publishedTime || typeof metadata?.publishedDate === "string" && metadata.publishedDate || void 0;
		items.push({
			title,
			url,
			description,
			content,
			published,
			siteName: resolveSiteName(url)
		});
	}
	return items;
}
function buildSearchPayload(params) {
	return {
		query: params.query,
		provider: params.provider,
		count: params.items.length,
		tookMs: params.tookMs,
		externalContent: {
			untrusted: true,
			source: "web_search",
			provider: params.provider,
			wrapped: true
		},
		results: params.items.map((entry) => ({
			title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
			url: entry.url,
			description: entry.description ? wrapWebContent(entry.description, "web_search") : "",
			...entry.published ? { published: entry.published } : {},
			...entry.siteName ? { siteName: entry.siteName } : {},
			...params.scrapeResults && entry.content ? { content: wrapWebContent(entry.content, "web_search") } : {}
		}))
	};
}
async function runFirecrawlSearch(params) {
	const apiKey = resolveFirecrawlApiKey(params.cfg);
	if (!apiKey) throw new Error("web_search (firecrawl) needs a Firecrawl API key. Set FIRECRAWL_API_KEY in the Gateway environment, or configure tools.web.search.firecrawl.apiKey.");
	const count = typeof params.count === "number" && Number.isFinite(params.count) ? Math.max(1, Math.min(10, Math.floor(params.count))) : DEFAULT_SEARCH_COUNT;
	const timeoutSeconds = resolveFirecrawlSearchTimeoutSeconds(params.timeoutSeconds);
	const scrapeResults = params.scrapeResults === true;
	const sources = Array.isArray(params.sources) ? params.sources.filter(Boolean) : [];
	const categories = Array.isArray(params.categories) ? params.categories.filter(Boolean) : [];
	const baseUrl = resolveFirecrawlBaseUrl(params.cfg);
	const cacheKey = normalizeCacheKey(JSON.stringify({
		type: "firecrawl-search",
		q: params.query,
		count,
		baseUrl,
		sources,
		categories,
		scrapeResults
	}));
	const cached = readCache(SEARCH_CACHE, cacheKey);
	if (cached) return {
		...cached.value,
		cached: true
	};
	const body = {
		query: params.query,
		limit: count
	};
	if (sources.length > 0) body.sources = sources;
	if (categories.length > 0) body.categories = categories;
	if (scrapeResults) body.scrapeOptions = { formats: ["markdown"] };
	const start = Date.now();
	const payload = await postFirecrawlJson({
		baseUrl,
		pathname: "/v2/search",
		apiKey,
		body,
		timeoutSeconds,
		errorLabel: "Firecrawl Search"
	});
	const result = buildSearchPayload({
		query: params.query,
		provider: "firecrawl",
		items: resolveSearchItems(payload),
		tookMs: Date.now() - start,
		scrapeResults
	});
	writeCache(SEARCH_CACHE, cacheKey, result, resolveCacheTtlMs(void 0, 15));
	return result;
}
function resolveScrapeData(payload) {
	const data = payload.data;
	if (data && typeof data === "object") return data;
	return {};
}
function parseFirecrawlScrapePayload(params) {
	const data = resolveScrapeData(params.payload);
	const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : void 0;
	const markdown = typeof data.markdown === "string" && data.markdown || typeof data.content === "string" && data.content || "";
	if (!markdown) throw new Error("Firecrawl scrape returned no content.");
	const rawText = params.extractMode === "text" ? markdownToText(markdown) : markdown;
	const truncated = truncateText(rawText, params.maxChars);
	return {
		url: params.url,
		finalUrl: typeof metadata?.sourceURL === "string" && metadata.sourceURL || typeof data.url === "string" && data.url || params.url,
		status: typeof metadata?.statusCode === "number" && metadata.statusCode || typeof data.statusCode === "number" && data.statusCode || void 0,
		title: typeof metadata?.title === "string" && metadata.title ? wrapExternalContent(metadata.title, {
			source: "web_fetch",
			includeWarning: false
		}) : void 0,
		extractor: "firecrawl",
		extractMode: params.extractMode,
		externalContent: {
			untrusted: true,
			source: "web_fetch",
			wrapped: true
		},
		truncated: truncated.truncated,
		rawLength: rawText.length,
		wrappedLength: wrapExternalContent(truncated.text, {
			source: "web_fetch",
			includeWarning: false
		}).length,
		text: wrapExternalContent(truncated.text, {
			source: "web_fetch",
			includeWarning: false
		}),
		warning: typeof params.payload.warning === "string" && params.payload.warning ? wrapExternalContent(params.payload.warning, {
			source: "web_fetch",
			includeWarning: false
		}) : void 0
	};
}
async function runFirecrawlScrape(params) {
	const apiKey = resolveFirecrawlApiKey(params.cfg);
	if (!apiKey) throw new Error("firecrawl_scrape needs a Firecrawl API key. Set FIRECRAWL_API_KEY in the Gateway environment, or configure tools.web.fetch.firecrawl.apiKey.");
	const baseUrl = resolveFirecrawlBaseUrl(params.cfg);
	const timeoutSeconds = resolveFirecrawlScrapeTimeoutSeconds(params.cfg, params.timeoutSeconds);
	const onlyMainContent = resolveFirecrawlOnlyMainContent(params.cfg, params.onlyMainContent);
	const maxAgeMs = resolveFirecrawlMaxAgeMs(params.cfg, params.maxAgeMs);
	const proxy = params.proxy ?? "auto";
	const storeInCache = params.storeInCache ?? true;
	const maxChars = typeof params.maxChars === "number" && Number.isFinite(params.maxChars) && params.maxChars > 0 ? Math.floor(params.maxChars) : DEFAULT_SCRAPE_MAX_CHARS;
	const cacheKey = normalizeCacheKey(JSON.stringify({
		type: "firecrawl-scrape",
		url: params.url,
		extractMode: params.extractMode,
		baseUrl,
		onlyMainContent,
		maxAgeMs,
		proxy,
		storeInCache,
		maxChars
	}));
	const cached = readCache(SCRAPE_CACHE, cacheKey);
	if (cached) return {
		...cached.value,
		cached: true
	};
	const result = parseFirecrawlScrapePayload({
		payload: await postFirecrawlJson({
			baseUrl,
			pathname: "/v2/scrape",
			apiKey,
			timeoutSeconds,
			errorLabel: "Firecrawl",
			body: {
				url: params.url,
				formats: ["markdown"],
				onlyMainContent,
				timeout: timeoutSeconds * 1e3,
				maxAge: maxAgeMs,
				proxy,
				storeInCache
			}
		}),
		url: params.url,
		extractMode: params.extractMode,
		maxChars
	});
	writeCache(SCRAPE_CACHE, cacheKey, result, resolveCacheTtlMs(void 0, 15));
	return result;
}
//#endregion
//#region extensions/firecrawl/src/firecrawl-search-provider.ts
const GenericFirecrawlSearchSchema = Type.Object({
	query: Type.String({ description: "Search query string." }),
	count: Type.Optional(Type.Number({
		description: "Number of results to return (1-10).",
		minimum: 1,
		maximum: 10
	}))
}, { additionalProperties: false });
function getScopedCredentialValue(searchConfig) {
	const scoped = searchConfig?.firecrawl;
	if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) return;
	return scoped.apiKey;
}
function setScopedCredentialValue(searchConfigTarget, value) {
	const scoped = searchConfigTarget.firecrawl;
	if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
		searchConfigTarget.firecrawl = { apiKey: value };
		return;
	}
	scoped.apiKey = value;
}
function createFirecrawlWebSearchProvider() {
	return {
		id: "firecrawl",
		label: "Firecrawl Search",
		hint: "Structured results with optional result scraping",
		envVars: ["FIRECRAWL_API_KEY"],
		placeholder: "fc-...",
		signupUrl: "https://www.firecrawl.dev/",
		docsUrl: "https://docs.openclaw.ai/tools/firecrawl",
		autoDetectOrder: 60,
		getCredentialValue: getScopedCredentialValue,
		setCredentialValue: setScopedCredentialValue,
		createTool: (ctx) => ({
			description: "Search the web using Firecrawl. Returns structured results with snippets from Firecrawl Search. Use firecrawl_search for Firecrawl-specific knobs like sources or categories.",
			parameters: GenericFirecrawlSearchSchema,
			execute: async (args) => await runFirecrawlSearch({
				cfg: ctx.config,
				query: typeof args.query === "string" ? args.query : "",
				count: typeof args.count === "number" ? args.count : void 0
			})
		})
	};
}
//#endregion
//#region src/infra/outbound/message-action-spec.ts
const MESSAGE_ACTION_TARGET_MODE = {
	send: "to",
	broadcast: "none",
	poll: "to",
	"poll-vote": "to",
	react: "to",
	reactions: "to",
	read: "to",
	edit: "to",
	unsend: "to",
	reply: "to",
	sendWithEffect: "to",
	renameGroup: "to",
	setGroupIcon: "to",
	addParticipant: "to",
	removeParticipant: "to",
	leaveGroup: "to",
	sendAttachment: "to",
	delete: "to",
	pin: "to",
	unpin: "to",
	"list-pins": "to",
	permissions: "to",
	"thread-create": "to",
	"thread-list": "none",
	"thread-reply": "to",
	search: "none",
	sticker: "to",
	"sticker-search": "none",
	"member-info": "none",
	"role-info": "none",
	"emoji-list": "none",
	"emoji-upload": "none",
	"sticker-upload": "none",
	"role-add": "none",
	"role-remove": "none",
	"channel-info": "channelId",
	"channel-list": "none",
	"channel-create": "none",
	"channel-edit": "channelId",
	"channel-delete": "channelId",
	"channel-move": "channelId",
	"category-create": "none",
	"category-edit": "none",
	"category-delete": "none",
	"topic-create": "to",
	"topic-edit": "to",
	"voice-status": "none",
	"event-list": "none",
	"event-create": "none",
	timeout: "none",
	kick: "none",
	ban: "none",
	"set-presence": "none",
	"download-file": "none"
};
const ACTION_TARGET_ALIASES = {
	read: {
		aliases: ["messageId"],
		channels: ["feishu"]
	},
	unsend: { aliases: ["messageId"] },
	edit: { aliases: ["messageId"] },
	pin: {
		aliases: ["messageId"],
		channels: ["feishu"]
	},
	unpin: {
		aliases: ["messageId"],
		channels: ["feishu"]
	},
	"list-pins": {
		aliases: ["chatId"],
		channels: ["feishu"]
	},
	"channel-info": {
		aliases: ["chatId"],
		channels: ["feishu"]
	},
	react: { aliases: [
		"chatGuid",
		"chatIdentifier",
		"chatId"
	] },
	renameGroup: { aliases: [
		"chatGuid",
		"chatIdentifier",
		"chatId"
	] },
	setGroupIcon: { aliases: [
		"chatGuid",
		"chatIdentifier",
		"chatId"
	] },
	addParticipant: { aliases: [
		"chatGuid",
		"chatIdentifier",
		"chatId"
	] },
	removeParticipant: { aliases: [
		"chatGuid",
		"chatIdentifier",
		"chatId"
	] },
	leaveGroup: { aliases: [
		"chatGuid",
		"chatIdentifier",
		"chatId"
	] }
};
function actionRequiresTarget(action) {
	return MESSAGE_ACTION_TARGET_MODE[action] !== "none";
}
function actionHasTarget(action, params, options) {
	if (typeof params.to === "string" ? params.to.trim() : "") return true;
	if (typeof params.channelId === "string" ? params.channelId.trim() : "") return true;
	const spec = ACTION_TARGET_ALIASES[action];
	if (!spec) return false;
	if (spec.channels && (!options?.channel || !spec.channels.includes(options.channel.trim().toLowerCase()))) return false;
	return spec.aliases.some((alias) => {
		const value = params[alias];
		if (typeof value === "string") return value.trim().length > 0;
		if (typeof value === "number") return Number.isFinite(value);
		return false;
	});
}
function hasNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function applyTargetToParams(params) {
	const target = typeof params.args.target === "string" ? params.args.target.trim() : "";
	const hasLegacyTo = hasNonEmptyString(params.args.to);
	const hasLegacyChannelId = hasNonEmptyString(params.args.channelId);
	const mode = MESSAGE_ACTION_TARGET_MODE[params.action] ?? "none";
	if (mode !== "none") {
		if (hasLegacyTo || hasLegacyChannelId) throw new Error("Use `target` instead of `to`/`channelId`.");
	} else if (hasLegacyTo) throw new Error("Use `target` for actions that accept a destination.");
	if (!target) return;
	if (mode === "channelId") {
		params.args.channelId = target;
		return;
	}
	if (mode === "to") {
		params.args.to = target;
		return;
	}
	throw new Error(`Action ${params.action} does not accept a target.`);
}
//#endregion
//#region src/agents/schema/typebox.ts
function stringEnum(values, options = {}) {
	return Type.Unsafe({
		type: "string",
		enum: [...values],
		...options
	});
}
function optionalStringEnum(values, options = {}) {
	return Type.Optional(stringEnum(values, options));
}
function channelTargetSchema(options) {
	return Type.String({ description: options?.description ?? "Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack channel/user, or iMessage handle/chat_id" });
}
function channelTargetsSchema(options) {
	return Type.Array(channelTargetSchema({ description: options?.description ?? "Recipient/channel targets (same format as --target); accepts ids or names when the directory is available." }));
}
//#endregion
export { applyTargetToParams as a, createFirecrawlWebSearchProvider as c, extractBasicHtmlContent as d, extractReadableContent as f, truncateText as h, stringEnum as i, runFirecrawlScrape as l, markdownToText as m, channelTargetsSchema as n, actionHasTarget as o, htmlToMarkdown as p, optionalStringEnum as r, actionRequiresTarget as s, channelTargetSchema as t, runFirecrawlSearch as u };
