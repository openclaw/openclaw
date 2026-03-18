import { a as init_types_secrets, c as normalizeResolvedSecretInputString } from "./types.secrets-Br5ssFsN.js";
import { t as formatCliCommand } from "./command-format-ZZqKRRhR.js";
import { g as init_globals, v as logVerbose } from "./subsystem-CsPxmH8p.js";
import { E as readStringParam, S as readNumberParam, a as readResponseText, b as jsonResult, c as writeCache, d as withTrustedWebToolsEndpoint, i as readCache, n as wrapWebContent, o as resolveCacheTtlMs, r as normalizeCacheKey, s as resolveTimeoutSeconds, u as withStrictWebToolsEndpoint, w as readStringArrayParam } from "./external-content-CxoN_TKD.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CZ08wtw1.js";
import { Type } from "@sinclair/typebox";
//#region src/agents/tools/web-search-citation-redirect.ts
const REDIRECT_TIMEOUT_MS = 5e3;
/**
* Resolve a citation redirect URL to its final destination using a HEAD request.
* Returns the original URL if resolution fails or times out.
*/
async function resolveCitationRedirectUrl(url) {
	try {
		return await withStrictWebToolsEndpoint({
			url,
			init: { method: "HEAD" },
			timeoutMs: REDIRECT_TIMEOUT_MS
		}, async ({ finalUrl }) => finalUrl || url);
	} catch {
		return url;
	}
}
//#endregion
//#region src/agents/tools/web-search-core.ts
init_types_secrets();
init_globals();
const SEARCH_PROVIDERS = [
	"brave",
	"gemini",
	"grok",
	"kimi",
	"perplexity"
];
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_LLM_CONTEXT_ENDPOINT = "https://api.search.brave.com/res/v1/llm/context";
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const PERPLEXITY_SEARCH_ENDPOINT = "https://api.perplexity.ai/search";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];
const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4-1-fast";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_KIMI_MODEL = "moonshot-v1-128k";
const KIMI_WEB_SEARCH_TOOL = {
	type: "builtin_function",
	function: { name: "$web_search" }
};
const SEARCH_CACHE_KEY = Symbol.for("openclaw.web-search.cache");
function getSharedSearchCache() {
	const root = globalThis;
	const existing = root[SEARCH_CACHE_KEY];
	if (existing instanceof Map) return existing;
	const next = /* @__PURE__ */ new Map();
	root[SEARCH_CACHE_KEY] = next;
	return next;
}
const SEARCH_CACHE = getSharedSearchCache();
const BRAVE_FRESHNESS_SHORTCUTS = new Set([
	"pd",
	"pw",
	"pm",
	"py"
]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;
const BRAVE_SEARCH_LANG_CODES = new Set([
	"ar",
	"eu",
	"bn",
	"bg",
	"ca",
	"zh-hans",
	"zh-hant",
	"hr",
	"cs",
	"da",
	"nl",
	"en",
	"en-gb",
	"et",
	"fi",
	"fr",
	"gl",
	"de",
	"el",
	"gu",
	"he",
	"hi",
	"hu",
	"is",
	"it",
	"jp",
	"kn",
	"ko",
	"lv",
	"lt",
	"ms",
	"ml",
	"mr",
	"nb",
	"pl",
	"pt-br",
	"pt-pt",
	"pa",
	"ro",
	"ru",
	"sr",
	"sk",
	"sl",
	"es",
	"sv",
	"ta",
	"te",
	"th",
	"tr",
	"uk",
	"vi"
]);
const BRAVE_SEARCH_LANG_ALIASES = {
	ja: "jp",
	zh: "zh-hans",
	"zh-cn": "zh-hans",
	"zh-hk": "zh-hant",
	"zh-sg": "zh-hans",
	"zh-tw": "zh-hant"
};
const BRAVE_UI_LANG_LOCALE = /^([a-z]{2})-([a-z]{2})$/i;
const PERPLEXITY_RECENCY_VALUES = new Set([
	"day",
	"week",
	"month",
	"year"
]);
const FRESHNESS_TO_RECENCY = {
	pd: "day",
	pw: "week",
	pm: "month",
	py: "year"
};
const RECENCY_TO_FRESHNESS = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py"
};
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERPLEXITY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
function isoToPerplexityDate(iso) {
	const match = iso.match(ISO_DATE_PATTERN);
	if (!match) return;
	const [, year, month, day] = match;
	return `${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`;
}
function normalizeToIsoDate(value) {
	const trimmed = value.trim();
	if (ISO_DATE_PATTERN.test(trimmed)) return isValidIsoDate(trimmed) ? trimmed : void 0;
	const match = trimmed.match(PERPLEXITY_DATE_PATTERN);
	if (match) {
		const [, month, day, year] = match;
		const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
		return isValidIsoDate(iso) ? iso : void 0;
	}
}
function createWebSearchSchema(params) {
	const querySchema = {
		query: Type.String({ description: "Search query string." }),
		count: Type.Optional(Type.Number({
			description: "Number of results to return (1-10).",
			minimum: 1,
			maximum: MAX_SEARCH_COUNT
		}))
	};
	const filterSchema = {
		country: Type.Optional(Type.String({ description: "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'." })),
		language: Type.Optional(Type.String({ description: "ISO 639-1 language code for results (e.g., 'en', 'de', 'fr')." })),
		freshness: Type.Optional(Type.String({ description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'." })),
		date_after: Type.Optional(Type.String({ description: "Only results published after this date (YYYY-MM-DD)." })),
		date_before: Type.Optional(Type.String({ description: "Only results published before this date (YYYY-MM-DD)." }))
	};
	const perplexityStructuredFilterSchema = {
		country: Type.Optional(Type.String({ description: "Native Perplexity Search API only. 2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'." })),
		language: Type.Optional(Type.String({ description: "Native Perplexity Search API only. ISO 639-1 language code for results (e.g., 'en', 'de', 'fr')." })),
		date_after: Type.Optional(Type.String({ description: "Native Perplexity Search API only. Only results published after this date (YYYY-MM-DD)." })),
		date_before: Type.Optional(Type.String({ description: "Native Perplexity Search API only. Only results published before this date (YYYY-MM-DD)." }))
	};
	if (params.provider === "brave") return Type.Object({
		...querySchema,
		...filterSchema,
		search_lang: Type.Optional(Type.String({ description: "Brave language code for search results (e.g., 'en', 'de', 'en-gb', 'zh-hans', 'zh-hant', 'pt-br')." })),
		ui_lang: Type.Optional(Type.String({ description: "Locale code for UI elements in language-region format (e.g., 'en-US', 'de-DE', 'fr-FR', 'tr-TR'). Must include region subtag." }))
	});
	if (params.provider === "perplexity") {
		if (params.perplexityTransport === "chat_completions") return Type.Object({
			...querySchema,
			freshness: filterSchema.freshness
		});
		return Type.Object({
			...querySchema,
			freshness: filterSchema.freshness,
			...perplexityStructuredFilterSchema,
			domain_filter: Type.Optional(Type.Array(Type.String(), { description: "Native Perplexity Search API only. Domain filter (max 20). Allowlist: ['nature.com'] or denylist: ['-reddit.com']. Cannot mix." })),
			max_tokens: Type.Optional(Type.Number({
				description: "Native Perplexity Search API only. Total content budget across all results (default: 25000, max: 1000000).",
				minimum: 1,
				maximum: 1e6
			})),
			max_tokens_per_page: Type.Optional(Type.Number({
				description: "Native Perplexity Search API only. Max tokens extracted per page (default: 2048).",
				minimum: 1
			}))
		});
	}
	return Type.Object({
		...querySchema,
		...filterSchema
	});
}
function extractPerplexityCitations(data) {
	const normalizeUrl = (value) => {
		if (typeof value !== "string") return;
		const trimmed = value.trim();
		return trimmed ? trimmed : void 0;
	};
	const topLevel = (data.citations ?? []).map(normalizeUrl).filter((url) => Boolean(url));
	if (topLevel.length > 0) return [...new Set(topLevel)];
	const citations = [];
	for (const choice of data.choices ?? []) for (const annotation of choice.message?.annotations ?? []) {
		if (annotation.type !== "url_citation") continue;
		const url = normalizeUrl(annotation.url_citation?.url ?? annotation.url);
		if (url) citations.push(url);
	}
	return [...new Set(citations)];
}
function extractGrokContent(data) {
	for (const output of data.output ?? []) {
		if (output.type === "message") {
			for (const block of output.content ?? []) if (block.type === "output_text" && typeof block.text === "string" && block.text) {
				const urls = (block.annotations ?? []).filter((a) => a.type === "url_citation" && typeof a.url === "string").map((a) => a.url);
				return {
					text: block.text,
					annotationCitations: [...new Set(urls)]
				};
			}
		}
		if (output.type === "output_text" && "text" in output && typeof output.text === "string" && output.text) {
			const urls = ("annotations" in output && Array.isArray(output.annotations) ? output.annotations : []).filter((a) => a.type === "url_citation" && typeof a.url === "string").map((a) => a.url);
			return {
				text: output.text,
				annotationCitations: [...new Set(urls)]
			};
		}
	}
	return {
		text: typeof data.output_text === "string" ? data.output_text : void 0,
		annotationCitations: []
	};
}
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
function resolveSearchConfig(cfg) {
	const search = cfg?.tools?.web?.search;
	if (!search || typeof search !== "object") return;
	return search;
}
function resolveSearchEnabled(params) {
	if (typeof params.search?.enabled === "boolean") return params.search.enabled;
	if (params.sandboxed) return true;
	return true;
}
function resolveSearchApiKey(search) {
	const fromConfig = normalizeSecretInput(search && "apiKey" in search ? normalizeResolvedSecretInputString({
		value: search.apiKey,
		path: "tools.web.search.apiKey"
	}) : void 0);
	const fromEnv = normalizeSecretInput(process.env.BRAVE_API_KEY);
	return fromConfig || fromEnv || void 0;
}
function missingSearchKeyPayload(provider) {
	if (provider === "brave") return {
		error: "missing_brave_api_key",
		message: `web_search (brave) needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
		docs: "https://docs.openclaw.ai/tools/web"
	};
	if (provider === "gemini") return {
		error: "missing_gemini_api_key",
		message: "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, or configure tools.web.search.gemini.apiKey.",
		docs: "https://docs.openclaw.ai/tools/web"
	};
	if (provider === "grok") return {
		error: "missing_xai_api_key",
		message: "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.search.grok.apiKey.",
		docs: "https://docs.openclaw.ai/tools/web"
	};
	if (provider === "kimi") return {
		error: "missing_kimi_api_key",
		message: "web_search (kimi) needs a Moonshot API key. Set KIMI_API_KEY or MOONSHOT_API_KEY in the Gateway environment, or configure tools.web.search.kimi.apiKey.",
		docs: "https://docs.openclaw.ai/tools/web"
	};
	return {
		error: "missing_perplexity_api_key",
		message: "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
		docs: "https://docs.openclaw.ai/tools/web"
	};
}
function isSearchProvider(value) {
	return SEARCH_PROVIDERS.includes(value);
}
function resolveSearchProvider(search) {
	const raw = search && "provider" in search && typeof search.provider === "string" ? search.provider.trim().toLowerCase() : "";
	if (raw === "brave") return "brave";
	if (raw === "gemini") return "gemini";
	if (raw === "grok") return "grok";
	if (raw === "kimi") return "kimi";
	if (raw === "perplexity") return "perplexity";
	if (raw === "") {
		if (resolveSearchApiKey(search)) {
			logVerbose("web_search: no provider configured, auto-detected \"brave\" from available API keys");
			return "brave";
		}
		if (resolveGeminiApiKey(resolveGeminiConfig(search))) {
			logVerbose("web_search: no provider configured, auto-detected \"gemini\" from available API keys");
			return "gemini";
		}
		if (resolveGrokApiKey(resolveGrokConfig(search))) {
			logVerbose("web_search: no provider configured, auto-detected \"grok\" from available API keys");
			return "grok";
		}
		if (resolveKimiApiKey(resolveKimiConfig(search))) {
			logVerbose("web_search: no provider configured, auto-detected \"kimi\" from available API keys");
			return "kimi";
		}
		const { apiKey: perplexityKey } = resolvePerplexityApiKey(resolvePerplexityConfig(search));
		if (perplexityKey) {
			logVerbose("web_search: no provider configured, auto-detected \"perplexity\" from available API keys");
			return "perplexity";
		}
	}
	return "brave";
}
function resolveBraveConfig(search) {
	if (!search || typeof search !== "object") return {};
	const brave = "brave" in search ? search.brave : void 0;
	if (!brave || typeof brave !== "object") return {};
	return brave;
}
function resolveBraveMode(brave) {
	return brave.mode === "llm-context" ? "llm-context" : "web";
}
function resolvePerplexityConfig(search) {
	if (!search || typeof search !== "object") return {};
	const perplexity = "perplexity" in search ? search.perplexity : void 0;
	if (!perplexity || typeof perplexity !== "object") return {};
	return perplexity;
}
function resolvePerplexityApiKey(perplexity) {
	const fromConfig = normalizeApiKey(perplexity?.apiKey);
	if (fromConfig) return {
		apiKey: fromConfig,
		source: "config"
	};
	const fromEnvPerplexity = normalizeApiKey(process.env.PERPLEXITY_API_KEY);
	if (fromEnvPerplexity) return {
		apiKey: fromEnvPerplexity,
		source: "perplexity_env"
	};
	const fromEnvOpenRouter = normalizeApiKey(process.env.OPENROUTER_API_KEY);
	if (fromEnvOpenRouter) return {
		apiKey: fromEnvOpenRouter,
		source: "openrouter_env"
	};
	return {
		apiKey: void 0,
		source: "none"
	};
}
function normalizeApiKey(key) {
	return normalizeSecretInput(key);
}
function inferPerplexityBaseUrlFromApiKey(apiKey) {
	if (!apiKey) return;
	const normalized = apiKey.toLowerCase();
	if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return "direct";
	if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return "openrouter";
}
function resolvePerplexityBaseUrl(perplexity, authSource = "none", configuredKey) {
	const fromConfig = perplexity && "baseUrl" in perplexity && typeof perplexity.baseUrl === "string" ? perplexity.baseUrl.trim() : "";
	if (fromConfig) return fromConfig;
	if (authSource === "perplexity_env") return PERPLEXITY_DIRECT_BASE_URL;
	if (authSource === "openrouter_env") return DEFAULT_PERPLEXITY_BASE_URL;
	if (authSource === "config") {
		if (inferPerplexityBaseUrlFromApiKey(configuredKey) === "openrouter") return DEFAULT_PERPLEXITY_BASE_URL;
		return PERPLEXITY_DIRECT_BASE_URL;
	}
	return DEFAULT_PERPLEXITY_BASE_URL;
}
function resolvePerplexityModel(perplexity) {
	return (perplexity && "model" in perplexity && typeof perplexity.model === "string" ? perplexity.model.trim() : "") || DEFAULT_PERPLEXITY_MODEL;
}
function isDirectPerplexityBaseUrl(baseUrl) {
	const trimmed = baseUrl.trim();
	if (!trimmed) return false;
	try {
		return new URL(trimmed).hostname.toLowerCase() === "api.perplexity.ai";
	} catch {
		return false;
	}
}
function resolvePerplexityRequestModel(baseUrl, model) {
	if (!isDirectPerplexityBaseUrl(baseUrl)) return model;
	return model.startsWith("perplexity/") ? model.slice(11) : model;
}
function resolvePerplexityTransport(perplexity) {
	const auth = resolvePerplexityApiKey(perplexity);
	const baseUrl = resolvePerplexityBaseUrl(perplexity, auth.source, auth.apiKey);
	const model = resolvePerplexityModel(perplexity);
	const hasLegacyOverride = Boolean(perplexity?.baseUrl && perplexity.baseUrl.trim() || perplexity?.model && perplexity.model.trim());
	return {
		...auth,
		baseUrl,
		model,
		transport: hasLegacyOverride || !isDirectPerplexityBaseUrl(baseUrl) ? "chat_completions" : "search_api"
	};
}
function resolvePerplexitySchemaTransportHint(perplexity) {
	return Boolean(perplexity?.baseUrl && perplexity.baseUrl.trim() || perplexity?.model && perplexity.model.trim()) ? "chat_completions" : void 0;
}
function resolveGrokConfig(search) {
	if (!search || typeof search !== "object") return {};
	const grok = "grok" in search ? search.grok : void 0;
	if (!grok || typeof grok !== "object") return {};
	return grok;
}
function resolveGrokApiKey(grok) {
	const fromConfig = normalizeApiKey(grok?.apiKey);
	if (fromConfig) return fromConfig;
	return normalizeApiKey(process.env.XAI_API_KEY) || void 0;
}
function resolveGrokModel(grok) {
	return (grok && "model" in grok && typeof grok.model === "string" ? grok.model.trim() : "") || DEFAULT_GROK_MODEL;
}
function resolveGrokInlineCitations(grok) {
	return grok?.inlineCitations === true;
}
function resolveKimiConfig(search) {
	if (!search || typeof search !== "object") return {};
	const kimi = "kimi" in search ? search.kimi : void 0;
	if (!kimi || typeof kimi !== "object") return {};
	return kimi;
}
function resolveKimiApiKey(kimi) {
	const fromConfig = normalizeApiKey(kimi?.apiKey);
	if (fromConfig) return fromConfig;
	const fromEnvKimi = normalizeApiKey(process.env.KIMI_API_KEY);
	if (fromEnvKimi) return fromEnvKimi;
	return normalizeApiKey(process.env.MOONSHOT_API_KEY) || void 0;
}
function resolveKimiModel(kimi) {
	return (kimi && "model" in kimi && typeof kimi.model === "string" ? kimi.model.trim() : "") || DEFAULT_KIMI_MODEL;
}
function resolveKimiBaseUrl(kimi) {
	return (kimi && "baseUrl" in kimi && typeof kimi.baseUrl === "string" ? kimi.baseUrl.trim() : "") || DEFAULT_KIMI_BASE_URL;
}
function resolveGeminiConfig(search) {
	if (!search || typeof search !== "object") return {};
	const gemini = "gemini" in search ? search.gemini : void 0;
	if (!gemini || typeof gemini !== "object") return {};
	return gemini;
}
function resolveGeminiApiKey(gemini) {
	const fromConfig = normalizeApiKey(gemini?.apiKey);
	if (fromConfig) return fromConfig;
	return normalizeApiKey(process.env.GEMINI_API_KEY) || void 0;
}
function resolveGeminiModel(gemini) {
	return (gemini && "model" in gemini && typeof gemini.model === "string" ? gemini.model.trim() : "") || DEFAULT_GEMINI_MODEL;
}
async function withTrustedWebSearchEndpoint(params, run) {
	return withTrustedWebToolsEndpoint({
		url: params.url,
		init: params.init,
		timeoutSeconds: params.timeoutSeconds
	}, async ({ response }) => run(response));
}
async function runGeminiSearch(params) {
	return withTrustedWebSearchEndpoint({
		url: `${GEMINI_API_BASE}/models/${params.model}:generateContent`,
		timeoutSeconds: params.timeoutSeconds,
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-goog-api-key": params.apiKey
			},
			body: JSON.stringify({
				contents: [{ parts: [{ text: params.query }] }],
				tools: [{ google_search: {} }]
			})
		}
	}, async (res) => {
		if (!res.ok) {
			const safeDetail = ((await readResponseText(res, { maxBytes: 64e3 })).text || res.statusText).replace(/key=[^&\s]+/gi, "key=***");
			throw new Error(`Gemini API error (${res.status}): ${safeDetail}`);
		}
		let data;
		try {
			data = await res.json();
		} catch (err) {
			const safeError = String(err).replace(/key=[^&\s]+/gi, "key=***");
			throw new Error(`Gemini API returned invalid JSON: ${safeError}`, { cause: err });
		}
		if (data.error) {
			const safeMsg = (data.error.message || data.error.status || "unknown").replace(/key=[^&\s]+/gi, "key=***");
			throw new Error(`Gemini API error (${data.error.code}): ${safeMsg}`);
		}
		const candidate = data.candidates?.[0];
		const content = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n") ?? "No response";
		const rawCitations = (candidate?.groundingMetadata?.groundingChunks ?? []).filter((chunk) => chunk.web?.uri).map((chunk) => ({
			url: chunk.web.uri,
			title: chunk.web?.title || void 0
		}));
		const MAX_CONCURRENT_REDIRECTS = 10;
		const citations = [];
		for (let i = 0; i < rawCitations.length; i += MAX_CONCURRENT_REDIRECTS) {
			const batch = rawCitations.slice(i, i + MAX_CONCURRENT_REDIRECTS);
			const resolved = await Promise.all(batch.map(async (citation) => {
				const resolvedUrl = await resolveCitationRedirectUrl(citation.url);
				return {
					...citation,
					url: resolvedUrl
				};
			}));
			citations.push(...resolved);
		}
		return {
			content,
			citations
		};
	});
}
function resolveSearchCount(value, fallback) {
	const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
}
function normalizeBraveSearchLang(value) {
	if (!value) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	const canonical = BRAVE_SEARCH_LANG_ALIASES[trimmed.toLowerCase()] ?? trimmed.toLowerCase();
	if (!BRAVE_SEARCH_LANG_CODES.has(canonical)) return;
	return canonical;
}
function normalizeBraveUiLang(value) {
	if (!value) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	const match = trimmed.match(BRAVE_UI_LANG_LOCALE);
	if (!match) return;
	const [, language, region] = match;
	return `${language.toLowerCase()}-${region.toUpperCase()}`;
}
function normalizeBraveLanguageParams(params) {
	const rawSearchLang = params.search_lang?.trim() || void 0;
	const rawUiLang = params.ui_lang?.trim() || void 0;
	let searchLangCandidate = rawSearchLang;
	let uiLangCandidate = rawUiLang;
	if (normalizeBraveUiLang(rawSearchLang) && normalizeBraveSearchLang(rawUiLang)) {
		searchLangCandidate = rawUiLang;
		uiLangCandidate = rawSearchLang;
	}
	const search_lang = normalizeBraveSearchLang(searchLangCandidate);
	if (searchLangCandidate && !search_lang) return { invalidField: "search_lang" };
	const ui_lang = normalizeBraveUiLang(uiLangCandidate);
	if (uiLangCandidate && !ui_lang) return { invalidField: "ui_lang" };
	return {
		search_lang,
		ui_lang
	};
}
/**
* Normalizes freshness shortcut to the provider's expected format.
* Accepts both Brave format (pd/pw/pm/py) and Perplexity format (day/week/month/year).
* For Brave, also accepts date ranges (YYYY-MM-DDtoYYYY-MM-DD).
*/
function normalizeFreshness(value, provider) {
	if (!value) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	const lower = trimmed.toLowerCase();
	if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) return provider === "brave" ? lower : FRESHNESS_TO_RECENCY[lower];
	if (PERPLEXITY_RECENCY_VALUES.has(lower)) return provider === "perplexity" ? lower : RECENCY_TO_FRESHNESS[lower];
	if (provider === "brave") {
		const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
		if (match) {
			const [, start, end] = match;
			if (isValidIsoDate(start) && isValidIsoDate(end) && start <= end) return `${start}to${end}`;
		}
	}
}
function isValidIsoDate(value) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
	if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function resolveSiteName(url) {
	if (!url) return;
	try {
		return new URL(url).hostname;
	} catch {
		return;
	}
}
async function throwWebSearchApiError(res, providerLabel) {
	const detail = (await readResponseText(res, { maxBytes: 64e3 })).text;
	throw new Error(`${providerLabel} API error (${res.status}): ${detail || res.statusText}`);
}
async function runPerplexitySearchApi(params) {
	const body = {
		query: params.query,
		max_results: params.count
	};
	if (params.country) body.country = params.country;
	if (params.searchDomainFilter && params.searchDomainFilter.length > 0) body.search_domain_filter = params.searchDomainFilter;
	if (params.searchRecencyFilter) body.search_recency_filter = params.searchRecencyFilter;
	if (params.searchLanguageFilter && params.searchLanguageFilter.length > 0) body.search_language_filter = params.searchLanguageFilter;
	if (params.searchAfterDate) body.search_after_date = params.searchAfterDate;
	if (params.searchBeforeDate) body.search_before_date = params.searchBeforeDate;
	if (params.maxTokens !== void 0) body.max_tokens = params.maxTokens;
	if (params.maxTokensPerPage !== void 0) body.max_tokens_per_page = params.maxTokensPerPage;
	return withTrustedWebSearchEndpoint({
		url: PERPLEXITY_SEARCH_ENDPOINT,
		timeoutSeconds: params.timeoutSeconds,
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Authorization: `Bearer ${params.apiKey}`,
				"HTTP-Referer": "https://openclaw.ai",
				"X-Title": "OpenClaw Web Search"
			},
			body: JSON.stringify(body)
		}
	}, async (res) => {
		if (!res.ok) return await throwWebSearchApiError(res, "Perplexity Search");
		const data = await res.json();
		return (Array.isArray(data.results) ? data.results : []).map((entry) => {
			const title = entry.title ?? "";
			const url = entry.url ?? "";
			const snippet = entry.snippet ?? "";
			return {
				title: title ? wrapWebContent(title, "web_search") : "",
				url,
				description: snippet ? wrapWebContent(snippet, "web_search") : "",
				published: entry.date ?? void 0,
				siteName: resolveSiteName(url) || void 0
			};
		});
	});
}
async function runPerplexitySearch(params) {
	const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
	const endpoint = `${baseUrl}/chat/completions`;
	const body = {
		model: resolvePerplexityRequestModel(baseUrl, params.model),
		messages: [{
			role: "user",
			content: params.query
		}]
	};
	if (params.freshness) body.search_recency_filter = params.freshness;
	return withTrustedWebSearchEndpoint({
		url: endpoint,
		timeoutSeconds: params.timeoutSeconds,
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${params.apiKey}`,
				"HTTP-Referer": "https://openclaw.ai",
				"X-Title": "OpenClaw Web Search"
			},
			body: JSON.stringify(body)
		}
	}, async (res) => {
		if (!res.ok) return await throwWebSearchApiError(res, "Perplexity");
		const data = await res.json();
		return {
			content: data.choices?.[0]?.message?.content ?? "No response",
			citations: extractPerplexityCitations(data)
		};
	});
}
async function runGrokSearch(params) {
	const body = {
		model: params.model,
		input: [{
			role: "user",
			content: params.query
		}],
		tools: [{ type: "web_search" }]
	};
	return withTrustedWebSearchEndpoint({
		url: XAI_API_ENDPOINT,
		timeoutSeconds: params.timeoutSeconds,
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${params.apiKey}`
			},
			body: JSON.stringify(body)
		}
	}, async (res) => {
		if (!res.ok) return await throwWebSearchApiError(res, "xAI");
		const data = await res.json();
		const { text: extractedText, annotationCitations } = extractGrokContent(data);
		return {
			content: extractedText ?? "No response",
			citations: (data.citations ?? []).length > 0 ? data.citations : annotationCitations,
			inlineCitations: data.inline_citations
		};
	});
}
function extractKimiMessageText(message) {
	const content = message?.content?.trim();
	if (content) return content;
	return message?.reasoning_content?.trim() || void 0;
}
function extractKimiCitations(data) {
	const citations = (data.search_results ?? []).map((entry) => entry.url?.trim()).filter((url) => Boolean(url));
	for (const toolCall of data.choices?.[0]?.message?.tool_calls ?? []) {
		const rawArguments = toolCall.function?.arguments;
		if (!rawArguments) continue;
		try {
			const parsed = JSON.parse(rawArguments);
			if (typeof parsed.url === "string" && parsed.url.trim()) citations.push(parsed.url.trim());
			for (const result of parsed.search_results ?? []) if (typeof result.url === "string" && result.url.trim()) citations.push(result.url.trim());
		} catch {}
	}
	return [...new Set(citations)];
}
function buildKimiToolResultContent(data) {
	return JSON.stringify({ search_results: (data.search_results ?? []).map((entry) => ({
		title: entry.title ?? "",
		url: entry.url ?? "",
		content: entry.content ?? ""
	})) });
}
async function runKimiSearch(params) {
	const endpoint = `${params.baseUrl.trim().replace(/\/$/, "")}/chat/completions`;
	const messages = [{
		role: "user",
		content: params.query
	}];
	const collectedCitations = /* @__PURE__ */ new Set();
	const MAX_ROUNDS = 3;
	for (let round = 0; round < MAX_ROUNDS; round += 1) {
		const nextResult = await withTrustedWebSearchEndpoint({
			url: endpoint,
			timeoutSeconds: params.timeoutSeconds,
			init: {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${params.apiKey}`
				},
				body: JSON.stringify({
					model: params.model,
					messages,
					tools: [KIMI_WEB_SEARCH_TOOL]
				})
			}
		}, async (res) => {
			if (!res.ok) return await throwWebSearchApiError(res, "Kimi");
			const data = await res.json();
			for (const citation of extractKimiCitations(data)) collectedCitations.add(citation);
			const choice = data.choices?.[0];
			const message = choice?.message;
			const text = extractKimiMessageText(message);
			const toolCalls = message?.tool_calls ?? [];
			if (choice?.finish_reason !== "tool_calls" || toolCalls.length === 0) return {
				done: true,
				content: text ?? "No response",
				citations: [...collectedCitations]
			};
			messages.push({
				role: "assistant",
				content: message?.content ?? "",
				...message?.reasoning_content ? { reasoning_content: message.reasoning_content } : {},
				tool_calls: toolCalls
			});
			const toolContent = buildKimiToolResultContent(data);
			let pushedToolResult = false;
			for (const toolCall of toolCalls) {
				const toolCallId = toolCall.id?.trim();
				if (!toolCallId) continue;
				pushedToolResult = true;
				messages.push({
					role: "tool",
					tool_call_id: toolCallId,
					content: toolContent
				});
			}
			if (!pushedToolResult) return {
				done: true,
				content: text ?? "No response",
				citations: [...collectedCitations]
			};
			return { done: false };
		});
		if (nextResult.done) return {
			content: nextResult.content,
			citations: nextResult.citations
		};
	}
	return {
		content: "Search completed but no final answer was produced.",
		citations: [...collectedCitations]
	};
}
function mapBraveLlmContextResults(data) {
	return (Array.isArray(data.grounding?.generic) ? data.grounding.generic : []).map((entry) => ({
		url: entry.url ?? "",
		title: entry.title ?? "",
		snippets: (entry.snippets ?? []).filter((s) => typeof s === "string" && s.length > 0),
		siteName: resolveSiteName(entry.url) || void 0
	}));
}
async function runBraveLlmContextSearch(params) {
	const url = new URL(BRAVE_LLM_CONTEXT_ENDPOINT);
	url.searchParams.set("q", params.query);
	if (params.country) url.searchParams.set("country", params.country);
	if (params.search_lang) url.searchParams.set("search_lang", params.search_lang);
	if (params.freshness) url.searchParams.set("freshness", params.freshness);
	return withTrustedWebSearchEndpoint({
		url: url.toString(),
		timeoutSeconds: params.timeoutSeconds,
		init: {
			method: "GET",
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": params.apiKey
			}
		}
	}, async (res) => {
		if (!res.ok) {
			const detail = (await readResponseText(res, { maxBytes: 64e3 })).text;
			throw new Error(`Brave LLM Context API error (${res.status}): ${detail || res.statusText}`);
		}
		const data = await res.json();
		return {
			results: mapBraveLlmContextResults(data),
			sources: data.sources
		};
	});
}
async function runWebSearch(params) {
	const effectiveBraveMode = params.braveMode ?? "web";
	const providerSpecificKey = params.provider === "perplexity" ? `${params.perplexityTransport ?? "search_api"}:${params.perplexityBaseUrl ?? PERPLEXITY_DIRECT_BASE_URL}:${params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL}` : params.provider === "grok" ? `${params.grokModel ?? DEFAULT_GROK_MODEL}:${String(params.grokInlineCitations ?? false)}` : params.provider === "gemini" ? params.geminiModel ?? DEFAULT_GEMINI_MODEL : params.provider === "kimi" ? `${params.kimiBaseUrl ?? DEFAULT_KIMI_BASE_URL}:${params.kimiModel ?? DEFAULT_KIMI_MODEL}` : "";
	const cacheKey = normalizeCacheKey(params.provider === "brave" && effectiveBraveMode === "llm-context" ? `${params.provider}:llm-context:${params.query}:${params.country || "default"}:${params.search_lang || params.language || "default"}:${params.freshness || "default"}` : `${params.provider}:${effectiveBraveMode}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || params.language || "default"}:${params.ui_lang || "default"}:${params.freshness || "default"}:${params.dateAfter || "default"}:${params.dateBefore || "default"}:${params.searchDomainFilter?.join(",") || "default"}:${params.maxTokens || "default"}:${params.maxTokensPerPage || "default"}:${providerSpecificKey}`);
	const cached = readCache(SEARCH_CACHE, cacheKey);
	if (cached) return {
		...cached.value,
		cached: true
	};
	const start = Date.now();
	if (params.provider === "perplexity") {
		if (params.perplexityTransport === "chat_completions") {
			const { content, citations } = await runPerplexitySearch({
				query: params.query,
				apiKey: params.apiKey,
				baseUrl: params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL,
				model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
				timeoutSeconds: params.timeoutSeconds,
				freshness: params.freshness
			});
			const payload = {
				query: params.query,
				provider: params.provider,
				model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
				tookMs: Date.now() - start,
				externalContent: {
					untrusted: true,
					source: "web_search",
					provider: params.provider,
					wrapped: true
				},
				content: wrapWebContent(content, "web_search"),
				citations
			};
			writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
			return payload;
		}
		const results = await runPerplexitySearchApi({
			query: params.query,
			apiKey: params.apiKey,
			count: params.count,
			timeoutSeconds: params.timeoutSeconds,
			country: params.country,
			searchDomainFilter: params.searchDomainFilter,
			searchRecencyFilter: params.freshness,
			searchLanguageFilter: params.language ? [params.language] : void 0,
			searchAfterDate: params.dateAfter ? isoToPerplexityDate(params.dateAfter) : void 0,
			searchBeforeDate: params.dateBefore ? isoToPerplexityDate(params.dateBefore) : void 0,
			maxTokens: params.maxTokens,
			maxTokensPerPage: params.maxTokensPerPage
		});
		const payload = {
			query: params.query,
			provider: params.provider,
			count: results.length,
			tookMs: Date.now() - start,
			externalContent: {
				untrusted: true,
				source: "web_search",
				provider: params.provider,
				wrapped: true
			},
			results
		};
		writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
		return payload;
	}
	if (params.provider === "grok") {
		const { content, citations, inlineCitations } = await runGrokSearch({
			query: params.query,
			apiKey: params.apiKey,
			model: params.grokModel ?? DEFAULT_GROK_MODEL,
			timeoutSeconds: params.timeoutSeconds,
			inlineCitations: params.grokInlineCitations ?? false
		});
		const payload = {
			query: params.query,
			provider: params.provider,
			model: params.grokModel ?? DEFAULT_GROK_MODEL,
			tookMs: Date.now() - start,
			externalContent: {
				untrusted: true,
				source: "web_search",
				provider: params.provider,
				wrapped: true
			},
			content: wrapWebContent(content),
			citations,
			inlineCitations
		};
		writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
		return payload;
	}
	if (params.provider === "kimi") {
		const { content, citations } = await runKimiSearch({
			query: params.query,
			apiKey: params.apiKey,
			baseUrl: params.kimiBaseUrl ?? DEFAULT_KIMI_BASE_URL,
			model: params.kimiModel ?? DEFAULT_KIMI_MODEL,
			timeoutSeconds: params.timeoutSeconds
		});
		const payload = {
			query: params.query,
			provider: params.provider,
			model: params.kimiModel ?? DEFAULT_KIMI_MODEL,
			tookMs: Date.now() - start,
			externalContent: {
				untrusted: true,
				source: "web_search",
				provider: params.provider,
				wrapped: true
			},
			content: wrapWebContent(content),
			citations
		};
		writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
		return payload;
	}
	if (params.provider === "gemini") {
		const geminiResult = await runGeminiSearch({
			query: params.query,
			apiKey: params.apiKey,
			model: params.geminiModel ?? DEFAULT_GEMINI_MODEL,
			timeoutSeconds: params.timeoutSeconds
		});
		const payload = {
			query: params.query,
			provider: params.provider,
			model: params.geminiModel ?? DEFAULT_GEMINI_MODEL,
			tookMs: Date.now() - start,
			externalContent: {
				untrusted: true,
				source: "web_search",
				provider: params.provider,
				wrapped: true
			},
			content: wrapWebContent(geminiResult.content),
			citations: geminiResult.citations
		};
		writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
		return payload;
	}
	if (params.provider !== "brave") throw new Error("Unsupported web search provider.");
	if (effectiveBraveMode === "llm-context") {
		const { results: llmResults, sources } = await runBraveLlmContextSearch({
			query: params.query,
			apiKey: params.apiKey,
			timeoutSeconds: params.timeoutSeconds,
			country: params.country,
			search_lang: params.search_lang,
			freshness: params.freshness
		});
		const mapped = llmResults.map((entry) => ({
			title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
			url: entry.url,
			snippets: entry.snippets.map((s) => wrapWebContent(s, "web_search")),
			siteName: entry.siteName
		}));
		const payload = {
			query: params.query,
			provider: params.provider,
			mode: "llm-context",
			count: mapped.length,
			tookMs: Date.now() - start,
			externalContent: {
				untrusted: true,
				source: "web_search",
				provider: params.provider,
				wrapped: true
			},
			results: mapped,
			sources
		};
		writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
		return payload;
	}
	const url = new URL(BRAVE_SEARCH_ENDPOINT);
	url.searchParams.set("q", params.query);
	url.searchParams.set("count", String(params.count));
	if (params.country) url.searchParams.set("country", params.country);
	if (params.search_lang || params.language) url.searchParams.set("search_lang", params.search_lang || params.language);
	if (params.ui_lang) url.searchParams.set("ui_lang", params.ui_lang);
	if (params.freshness) url.searchParams.set("freshness", params.freshness);
	else if (params.dateAfter && params.dateBefore) url.searchParams.set("freshness", `${params.dateAfter}to${params.dateBefore}`);
	else if (params.dateAfter) url.searchParams.set("freshness", `${params.dateAfter}to${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`);
	else if (params.dateBefore) url.searchParams.set("freshness", `1970-01-01to${params.dateBefore}`);
	const mapped = await withTrustedWebSearchEndpoint({
		url: url.toString(),
		timeoutSeconds: params.timeoutSeconds,
		init: {
			method: "GET",
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": params.apiKey
			}
		}
	}, async (res) => {
		if (!res.ok) {
			const detail = (await readResponseText(res, { maxBytes: 64e3 })).text;
			throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
		}
		const data = await res.json();
		return (Array.isArray(data.web?.results) ? data.web?.results ?? [] : []).map((entry) => {
			const description = entry.description ?? "";
			const title = entry.title ?? "";
			const url = entry.url ?? "";
			const rawSiteName = resolveSiteName(url);
			return {
				title: title ? wrapWebContent(title, "web_search") : "",
				url,
				description: description ? wrapWebContent(description, "web_search") : "",
				published: entry.age || void 0,
				siteName: rawSiteName || void 0
			};
		});
	});
	const payload = {
		query: params.query,
		provider: params.provider,
		count: mapped.length,
		tookMs: Date.now() - start,
		externalContent: {
			untrusted: true,
			source: "web_search",
			provider: params.provider,
			wrapped: true
		},
		results: mapped
	};
	writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
	return payload;
}
function createWebSearchTool(options) {
	const search = resolveSearchConfig(options?.config);
	if (!resolveSearchEnabled({
		search,
		sandboxed: options?.sandboxed
	})) return null;
	const runtimeProviderCandidate = options?.runtimeWebSearch?.selectedProvider ?? options?.runtimeWebSearch?.providerConfigured;
	const provider = runtimeProviderCandidate && isSearchProvider(runtimeProviderCandidate) ? runtimeProviderCandidate : resolveSearchProvider(search);
	const perplexityConfig = resolvePerplexityConfig(search);
	const perplexitySchemaTransportHint = options?.runtimeWebSearch?.perplexityTransport ?? resolvePerplexitySchemaTransportHint(perplexityConfig);
	const grokConfig = resolveGrokConfig(search);
	const geminiConfig = resolveGeminiConfig(search);
	const kimiConfig = resolveKimiConfig(search);
	const braveMode = resolveBraveMode(resolveBraveConfig(search));
	return {
		label: "Web Search",
		name: "web_search",
		description: provider === "perplexity" ? perplexitySchemaTransportHint === "chat_completions" ? "Search the web using Perplexity Sonar via Perplexity/OpenRouter chat completions. Returns AI-synthesized answers with citations from web-grounded search." : "Search the web using Perplexity. Runtime routing decides between native Search API and Sonar chat-completions compatibility. Structured filters are available on the native Search API path." : provider === "grok" ? "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search." : provider === "kimi" ? "Search the web using Kimi by Moonshot. Returns AI-synthesized answers with citations from native $web_search." : provider === "gemini" ? "Search the web using Gemini with Google Search grounding. Returns AI-synthesized answers with citations from Google Search." : braveMode === "llm-context" ? "Search the web using Brave Search LLM Context API. Returns pre-extracted page content (text chunks, tables, code blocks) optimized for LLM grounding." : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.",
		parameters: createWebSearchSchema({
			provider,
			perplexityTransport: provider === "perplexity" ? perplexitySchemaTransportHint : void 0
		}),
		execute: async (_toolCallId, args) => {
			const perplexityRuntime = provider === "perplexity" ? resolvePerplexityTransport(perplexityConfig) : void 0;
			const apiKey = provider === "perplexity" ? perplexityRuntime?.apiKey : provider === "grok" ? resolveGrokApiKey(grokConfig) : provider === "kimi" ? resolveKimiApiKey(kimiConfig) : provider === "gemini" ? resolveGeminiApiKey(geminiConfig) : resolveSearchApiKey(search);
			if (!apiKey) return jsonResult(missingSearchKeyPayload(provider));
			const supportsStructuredPerplexityFilters = provider === "perplexity" && perplexityRuntime?.transport === "search_api";
			const params = args;
			const query = readStringParam(params, "query", { required: true });
			const count = readNumberParam(params, "count", { integer: true }) ?? search?.maxResults ?? void 0;
			const country = readStringParam(params, "country");
			if (country && provider !== "brave" && !(provider === "perplexity" && supportsStructuredPerplexityFilters)) return jsonResult({
				error: "unsupported_country",
				message: provider === "perplexity" ? "country filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it." : `country filtering is not supported by the ${provider} provider. Only Brave and Perplexity support country filtering.`,
				docs: "https://docs.openclaw.ai/tools/web"
			});
			const language = readStringParam(params, "language");
			if (language && provider !== "brave" && !(provider === "perplexity" && supportsStructuredPerplexityFilters)) return jsonResult({
				error: "unsupported_language",
				message: provider === "perplexity" ? "language filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it." : `language filtering is not supported by the ${provider} provider. Only Brave and Perplexity support language filtering.`,
				docs: "https://docs.openclaw.ai/tools/web"
			});
			if (language && provider === "perplexity" && !/^[a-z]{2}$/i.test(language)) return jsonResult({
				error: "invalid_language",
				message: "language must be a 2-letter ISO 639-1 code like 'en', 'de', or 'fr'.",
				docs: "https://docs.openclaw.ai/tools/web"
			});
			const search_lang = readStringParam(params, "search_lang");
			const ui_lang = readStringParam(params, "ui_lang");
			const normalizedBraveLanguageParams = provider === "brave" ? normalizeBraveLanguageParams({
				search_lang: search_lang || language,
				ui_lang
			}) : {
				search_lang: language,
				ui_lang
			};
			if (normalizedBraveLanguageParams.invalidField === "search_lang") return jsonResult({
				error: "invalid_search_lang",
				message: "search_lang must be a Brave-supported language code like 'en', 'en-gb', 'zh-hans', or 'zh-hant'.",
				docs: "https://docs.openclaw.ai/tools/web"
			});
			if (normalizedBraveLanguageParams.invalidField === "ui_lang") return jsonResult({
				error: "invalid_ui_lang",
				message: "ui_lang must be a language-region locale like 'en-US'.",
				docs: "https://docs.openclaw.ai/tools/web"
			});
			const resolvedSearchLang = normalizedBraveLanguageParams.search_lang;
			const resolvedUiLang = normalizedBraveLanguageParams.ui_lang;
			if (resolvedUiLang && provider === "brave" && braveMode === "llm-context") return jsonResult({
				error: "unsupported_ui_lang",
				message: "ui_lang is not supported by Brave llm-context mode. Remove ui_lang or use Brave web mode for locale-based UI hints.",
				docs: "https://docs.openclaw.ai/tools/web"
			});
			const rawFreshness = readStringParam(params, "freshness");
			if (rawFreshness && provider !== "brave" && provider !== "perplexity") return jsonResult({
				error: "unsupported_freshness",
				message: `freshness filtering is not supported by the ${provider} provider. Only Brave and Perplexity support freshness.`,
				docs: "https://docs.openclaw.ai/tools/web"
			});
			if (rawFreshness && provider === "brave" && braveMode === "llm-context") return jsonResult({
				error: "unsupported_freshness",
				message: "freshness filtering is not supported by Brave llm-context mode. Remove freshness or use Brave web mode.",
				docs: "https://docs.openclaw.ai/tools/web"
			});
			const freshness = rawFreshness ? normalizeFreshness(rawFreshness, provider) : void 0;
			if (rawFreshness && !freshness) return jsonResult({
				error: "invalid_freshness",
				message: "freshness must be day, week, month, or year.",
				docs: "https://docs.openclaw.ai/tools/web"
			});
			const rawDateAfter = readStringParam(params, "date_after");
			const rawDateBefore = readStringParam(params, "date_before");
			if (rawFreshness && (rawDateAfter || rawDateBefore)) return jsonResult({
				error: "conflicting_time_filters",
				message: "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
				docs: "https://docs.openclaw.ai/tools/web"
			});
			if ((rawDateAfter || rawDateBefore) && provider !== "brave" && !(provider === "perplexity" && supportsStructuredPerplexityFilters)) return jsonResult({
				error: "unsupported_date_filter",
				message: provider === "perplexity" ? "date_after/date_before are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them." : `date_after/date_before filtering is not supported by the ${provider} provider. Only Brave and Perplexity support date filtering.`,
				docs: "https://docs.openclaw.ai/tools/web"
			});
			if ((rawDateAfter || rawDateBefore) && provider === "brave" && braveMode === "llm-context") return jsonResult({
				error: "unsupported_date_filter",
				message: "date_after/date_before filtering is not supported by Brave llm-context mode. Use Brave web mode for date filters.",
				docs: "https://docs.openclaw.ai/tools/web"
			});
			const dateAfter = rawDateAfter ? normalizeToIsoDate(rawDateAfter) : void 0;
			if (rawDateAfter && !dateAfter) return jsonResult({
				error: "invalid_date",
				message: "date_after must be YYYY-MM-DD format.",
				docs: "https://docs.openclaw.ai/tools/web"
			});
			const dateBefore = rawDateBefore ? normalizeToIsoDate(rawDateBefore) : void 0;
			if (rawDateBefore && !dateBefore) return jsonResult({
				error: "invalid_date",
				message: "date_before must be YYYY-MM-DD format.",
				docs: "https://docs.openclaw.ai/tools/web"
			});
			if (dateAfter && dateBefore && dateAfter > dateBefore) return jsonResult({
				error: "invalid_date_range",
				message: "date_after must be before date_before.",
				docs: "https://docs.openclaw.ai/tools/web"
			});
			const domainFilter = readStringArrayParam(params, "domain_filter");
			if (domainFilter && domainFilter.length > 0 && !(provider === "perplexity" && supportsStructuredPerplexityFilters)) return jsonResult({
				error: "unsupported_domain_filter",
				message: provider === "perplexity" ? "domain_filter is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it." : `domain_filter is not supported by the ${provider} provider. Only Perplexity supports domain filtering.`,
				docs: "https://docs.openclaw.ai/tools/web"
			});
			if (domainFilter && domainFilter.length > 0) {
				const hasDenylist = domainFilter.some((d) => d.startsWith("-"));
				const hasAllowlist = domainFilter.some((d) => !d.startsWith("-"));
				if (hasDenylist && hasAllowlist) return jsonResult({
					error: "invalid_domain_filter",
					message: "domain_filter cannot mix allowlist and denylist entries. Use either all positive entries (allowlist) or all entries prefixed with '-' (denylist).",
					docs: "https://docs.openclaw.ai/tools/web"
				});
				if (domainFilter.length > 20) return jsonResult({
					error: "invalid_domain_filter",
					message: "domain_filter supports a maximum of 20 domains.",
					docs: "https://docs.openclaw.ai/tools/web"
				});
			}
			const maxTokens = readNumberParam(params, "max_tokens", { integer: true });
			const maxTokensPerPage = readNumberParam(params, "max_tokens_per_page", { integer: true });
			if (provider === "perplexity" && perplexityRuntime?.transport === "chat_completions" && (maxTokens !== void 0 || maxTokensPerPage !== void 0)) return jsonResult({
				error: "unsupported_content_budget",
				message: "max_tokens and max_tokens_per_page are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them.",
				docs: "https://docs.openclaw.ai/tools/web"
			});
			return jsonResult(await runWebSearch({
				query,
				count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
				apiKey,
				timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, 30),
				cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, 15),
				provider,
				country,
				language,
				search_lang: resolvedSearchLang,
				ui_lang: resolvedUiLang,
				freshness,
				dateAfter,
				dateBefore,
				searchDomainFilter: domainFilter,
				maxTokens: maxTokens ?? void 0,
				maxTokensPerPage: maxTokensPerPage ?? void 0,
				perplexityBaseUrl: perplexityRuntime?.baseUrl,
				perplexityModel: perplexityRuntime?.model,
				perplexityTransport: perplexityRuntime?.transport,
				grokModel: resolveGrokModel(grokConfig),
				grokInlineCitations: resolveGrokInlineCitations(grokConfig),
				geminiModel: resolveGeminiModel(geminiConfig),
				kimiBaseUrl: resolveKimiBaseUrl(kimiConfig),
				kimiModel: resolveKimiModel(kimiConfig),
				braveMode
			}));
		}
	};
}
const __testing = {
	resolveSearchProvider,
	inferPerplexityBaseUrlFromApiKey,
	resolvePerplexityBaseUrl,
	resolvePerplexityModel,
	resolvePerplexityTransport,
	isDirectPerplexityBaseUrl,
	resolvePerplexityRequestModel,
	resolvePerplexityApiKey,
	normalizeBraveLanguageParams,
	normalizeFreshness,
	normalizeToIsoDate,
	isoToPerplexityDate,
	SEARCH_CACHE,
	FRESHNESS_TO_RECENCY,
	RECENCY_TO_FRESHNESS,
	resolveGrokApiKey,
	resolveGrokModel,
	resolveGrokInlineCitations,
	extractGrokContent,
	resolveKimiApiKey,
	resolveKimiModel,
	resolveKimiBaseUrl,
	extractKimiCitations,
	resolveRedirectUrl: resolveCitationRedirectUrl,
	resolveBraveMode,
	mapBraveLlmContextResults
};
//#endregion
//#region src/agents/tools/web-search-plugin-factory.ts
function cloneWithDescriptors(value) {
	const next = Object.create(Object.getPrototypeOf(value ?? {}));
	if (value) Object.defineProperties(next, Object.getOwnPropertyDescriptors(value));
	return next;
}
function withForcedProvider(config, provider) {
	const next = cloneWithDescriptors(config ?? {});
	const tools = cloneWithDescriptors(next.tools ?? {});
	const web = cloneWithDescriptors(tools.web ?? {});
	const search = cloneWithDescriptors(web.search ?? {});
	search.provider = provider;
	web.search = search;
	tools.web = web;
	next.tools = tools;
	return next;
}
function createPluginBackedWebSearchProvider(provider) {
	return {
		...provider,
		createTool: (ctx) => {
			const tool = createWebSearchTool({
				config: withForcedProvider(ctx.config, provider.id),
				runtimeWebSearch: ctx.runtimeMetadata
			});
			if (!tool) return null;
			return {
				description: tool.description,
				parameters: tool.parameters,
				execute: async (args) => {
					return (await tool.execute(`web-search:${provider.id}`, args)).details ?? {};
				}
			};
		}
	};
}
function getTopLevelCredentialValue(searchConfig) {
	return searchConfig?.apiKey;
}
function setTopLevelCredentialValue(searchConfigTarget, value) {
	searchConfigTarget.apiKey = value;
}
function getScopedCredentialValue(searchConfig, key) {
	const scoped = searchConfig?.[key];
	if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) return;
	return scoped.apiKey;
}
function setScopedCredentialValue(searchConfigTarget, key, value) {
	const scoped = searchConfigTarget[key];
	if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
		searchConfigTarget[key] = { apiKey: value };
		return;
	}
	scoped.apiKey = value;
}
//#endregion
export { setTopLevelCredentialValue as a, setScopedCredentialValue as i, getScopedCredentialValue as n, __testing as o, getTopLevelCredentialValue as r, createPluginBackedWebSearchProvider as t };
