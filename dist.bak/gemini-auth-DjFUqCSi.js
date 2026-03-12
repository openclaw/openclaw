import { c as normalizeProviderId } from "./model-selection-aaCyoEgM.js";
import { n as formatErrorMessage } from "./errors-C6d5vwGh.js";

//#region src/agents/live-auth-keys.ts
const KEY_SPLIT_RE = /[\s,;]+/g;
const GOOGLE_LIVE_SINGLE_KEY = "OPENCLAW_LIVE_GEMINI_KEY";
const PROVIDER_PREFIX_OVERRIDES = {
	google: "GEMINI",
	"google-vertex": "GEMINI"
};
const PROVIDER_API_KEY_CONFIG = {
	anthropic: {
		liveSingle: "OPENCLAW_LIVE_ANTHROPIC_KEY",
		listVar: "OPENCLAW_LIVE_ANTHROPIC_KEYS",
		primaryVar: "ANTHROPIC_API_KEY",
		prefixedVar: "ANTHROPIC_API_KEY_"
	},
	google: {
		liveSingle: GOOGLE_LIVE_SINGLE_KEY,
		listVar: "GEMINI_API_KEYS",
		primaryVar: "GEMINI_API_KEY",
		prefixedVar: "GEMINI_API_KEY_"
	},
	"google-vertex": {
		liveSingle: GOOGLE_LIVE_SINGLE_KEY,
		listVar: "GEMINI_API_KEYS",
		primaryVar: "GEMINI_API_KEY",
		prefixedVar: "GEMINI_API_KEY_"
	},
	openai: {
		liveSingle: "OPENCLAW_LIVE_OPENAI_KEY",
		listVar: "OPENAI_API_KEYS",
		primaryVar: "OPENAI_API_KEY",
		prefixedVar: "OPENAI_API_KEY_"
	}
};
function parseKeyList(raw) {
	if (!raw) return [];
	return raw.split(KEY_SPLIT_RE).map((value) => value.trim()).filter(Boolean);
}
function collectEnvPrefixedKeys(prefix) {
	const keys = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith(prefix)) continue;
		const trimmed = value?.trim();
		if (!trimmed) continue;
		keys.push(trimmed);
	}
	return keys;
}
function resolveProviderApiKeyConfig(provider) {
	const normalized = normalizeProviderId(provider);
	const custom = PROVIDER_API_KEY_CONFIG[normalized];
	const base = PROVIDER_PREFIX_OVERRIDES[normalized] ?? normalized.toUpperCase().replace(/-/g, "_");
	const liveSingle = custom?.liveSingle ?? `OPENCLAW_LIVE_${base}_KEY`;
	const listVar = custom?.listVar ?? `${base}_API_KEYS`;
	const primaryVar = custom?.primaryVar ?? `${base}_API_KEY`;
	const prefixedVar = custom?.prefixedVar ?? `${base}_API_KEY_`;
	if (normalized === "google" || normalized === "google-vertex") return {
		liveSingle,
		listVar,
		primaryVar,
		prefixedVar,
		fallbackVars: ["GOOGLE_API_KEY"]
	};
	return {
		liveSingle,
		listVar,
		primaryVar,
		prefixedVar,
		fallbackVars: []
	};
}
function collectProviderApiKeys(provider) {
	const config = resolveProviderApiKeyConfig(provider);
	const forcedSingle = config.liveSingle ? process.env[config.liveSingle]?.trim() : void 0;
	if (forcedSingle) return [forcedSingle];
	const fromList = parseKeyList(config.listVar ? process.env[config.listVar] : void 0);
	const primary = config.primaryVar ? process.env[config.primaryVar]?.trim() : void 0;
	const fromPrefixed = config.prefixedVar ? collectEnvPrefixedKeys(config.prefixedVar) : [];
	const fallback = config.fallbackVars.map((envVar) => process.env[envVar]?.trim()).filter(Boolean);
	const seen = /* @__PURE__ */ new Set();
	const add = (value) => {
		if (!value) return;
		if (seen.has(value)) return;
		seen.add(value);
	};
	for (const value of fromList) add(value);
	add(primary);
	for (const value of fromPrefixed) add(value);
	for (const value of fallback) add(value);
	return Array.from(seen);
}
function isApiKeyRateLimitError(message) {
	const lower = message.toLowerCase();
	if (lower.includes("rate_limit")) return true;
	if (lower.includes("rate limit")) return true;
	if (lower.includes("429")) return true;
	if (lower.includes("quota exceeded") || lower.includes("quota_exceeded")) return true;
	if (lower.includes("resource exhausted") || lower.includes("resource_exhausted")) return true;
	if (lower.includes("too many requests")) return true;
	return false;
}

//#endregion
//#region src/agents/api-key-rotation.ts
function dedupeApiKeys(raw) {
	const seen = /* @__PURE__ */ new Set();
	const keys = [];
	for (const value of raw) {
		const apiKey = value.trim();
		if (!apiKey || seen.has(apiKey)) continue;
		seen.add(apiKey);
		keys.push(apiKey);
	}
	return keys;
}
function collectProviderApiKeysForExecution(params) {
	const { primaryApiKey, provider } = params;
	return dedupeApiKeys([primaryApiKey?.trim() ?? "", ...collectProviderApiKeys(provider)]);
}
async function executeWithApiKeyRotation(params) {
	const keys = dedupeApiKeys(params.apiKeys);
	if (keys.length === 0) throw new Error(`No API keys configured for provider "${params.provider}".`);
	let lastError;
	for (let attempt = 0; attempt < keys.length; attempt += 1) {
		const apiKey = keys[attempt];
		try {
			return await params.execute(apiKey);
		} catch (error) {
			lastError = error;
			const message = formatErrorMessage(error);
			if (!(params.shouldRetry ? params.shouldRetry({
				apiKey,
				error,
				attempt,
				message
			}) : isApiKeyRateLimitError(message)) || attempt + 1 >= keys.length) break;
			params.onRetry?.({
				apiKey,
				error,
				attempt,
				message
			});
		}
	}
	if (lastError === void 0) throw new Error(`Failed to run API request for ${params.provider}.`);
	throw lastError;
}

//#endregion
//#region src/infra/gemini-auth.ts
/**
* Shared Gemini authentication utilities.
*
* Supports both traditional API keys and OAuth JSON format.
*/
/**
* Parse Gemini API key and return appropriate auth headers.
*
* OAuth format: `{"token": "...", "projectId": "..."}`
*
* @param apiKey - Either a traditional API key string or OAuth JSON
* @returns Headers object with appropriate authentication
*/
function parseGeminiAuth(apiKey) {
	if (apiKey.startsWith("{")) try {
		const parsed = JSON.parse(apiKey);
		if (typeof parsed.token === "string" && parsed.token) return { headers: {
			Authorization: `Bearer ${parsed.token}`,
			"Content-Type": "application/json"
		} };
	} catch {}
	return { headers: {
		"x-goog-api-key": apiKey,
		"Content-Type": "application/json"
	} };
}

//#endregion
export { collectProviderApiKeysForExecution as n, executeWithApiKeyRotation as r, parseGeminiAuth as t };